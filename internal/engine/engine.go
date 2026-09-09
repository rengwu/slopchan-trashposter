package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	randv2 "math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Run struct {
	ID          string `json:"id"`
	StartedAt   int64  `json:"startedAt"`
	EndedAt     int64  `json:"endedAt,omitempty"`
	Status      string `json:"status"`
	Agent       string `json:"agent"`
	Space       string `json:"space"`
	Path        string `json:"path"`
	Personality string `json:"personality"`
	Color       string `json:"color"`
	DryRun      bool   `json:"dryRun"`
	Log         string `json:"log"`
	Text        string `json:"text"`
	Error       string `json:"error"`
	Thread      int64  `json:"thread,omitempty"`
	PostID      int64  `json:"postId,omitempty"`
	PostURL     string `json:"postUrl,omitempty"`
}
type State struct {
	Config       Config                     `json:"config"`
	Active       bool                       `json:"active"`
	NextAt       int64                      `json:"nextAt"`
	Running      string                     `json:"running"`
	Runs         []Run                      `json:"runs"`
	Session      string                     `json:"session"`
	Availability map[string]map[string]bool `json:"availability"`
	Presets      map[string]Entry           `json:"presets"`
}
type Engine struct {
	mu         sync.Mutex
	config     Config
	directory  string
	active     bool
	nextAt     int64
	timer      *time.Timer
	generation uint64
	current    *Run
	cancel     context.CancelFunc
	done       chan struct{}
	runs       []*Run
	session    string
	client     *http.Client
	closing    bool
}

func uuid() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func New(directory string) (*Engine, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return nil, err
	}
	c := Defaults()
	b, err := os.ReadFile(filepath.Join(directory, "config.json"))
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err = Validate(c); err != nil {
		return nil, err
	}
	e := &Engine{config: c, directory: directory, session: uuid(), runs: []*Run{}, client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Board redirects are not allowed.") }}}
	b, err = os.ReadFile(filepath.Join(directory, "history.json"))
	if err == nil {
		err = json.Unmarshal(b, &e.runs)
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(e.runs) > 100 {
		e.runs = e.runs[:100]
	}
	for _, r := range e.runs {
		if r.Status == "running" || r.Status == "posting" || r.Status == "queued" {
			r.Status = "interrupted"
			r.Error = "The app stopped during this run. Inspect the board before trying again."
		}
	}
	return e, nil
}
func executable(command string) string {
	p, err := exec.LookPath(ExpandPath(command))
	if err != nil {
		return ""
	}
	p, err = filepath.Abs(p)
	if err != nil {
		return ""
	}
	return p
}
func availability(c Config) map[string]map[string]bool {
	result := map[string]map[string]bool{"agents": {}, "spaces": {}}
	for _, a := range c.Agents {
		result["agents"][a.ID] = executable(a.Command) != ""
	}
	for _, s := range c.Spaces {
		v, err := os.Stat(ExpandPath(s.Path))
		result["spaces"][s.ID] = err == nil && v.IsDir()
	}
	return result
}
func choose(items []Entry, id string, available map[string]bool) (Entry, error) {
	pool := []Entry{}
	for _, v := range items {
		if v.Enabled && (id == "random" || v.ID == id) && (available == nil || available[v.ID]) {
			pool = append(pool, v)
		}
	}
	if len(pool) == 0 {
		return Entry{}, errors.New("Nothing available in the selected pool. Enable an entry or change the selection.")
	}
	return pool[randv2.IntN(len(pool))], nil
}
func interval(s Schedule) time.Duration {
	n := s.Interval
	if s.Mode == "random" {
		n = s.Min + randv2.IntN(s.Max-s.Min+1)
	}
	return time.Duration(n) * time.Second
}
func (e *Engine) checkLocked() error {
	if e.closing {
		return errors.New("The app is shutting down.")
	}
	c := e.config
	if !c.DryRun && strings.TrimSpace(c.Token) == "" {
		return errors.New("Set a posting token, or switch to preview mode.")
	}
	a := availability(c)
	if _, err := choose(c.Agents, c.Selection.Agent, a["agents"]); err != nil {
		return err
	}
	if _, err := choose(c.Spaces, c.Selection.Space, a["spaces"]); err != nil {
		return err
	}
	_, err := choose(c.Personalities, c.Selection.Personality, nil)
	return err
}
func redact(s string, c Config) string {
	secrets := []string{c.Token}
	for _, a := range c.Agents {
		for _, v := range a.Env {
			secrets = append(secrets, v)
		}
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	return s
}
func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := cloneConfig(e.config)
	c.HasToken = c.Token != ""
	c.Token = ""
	s := State{Config: c, Active: e.active, NextAt: e.nextAt, Session: e.session, Availability: availability(c), Runs: []Run{}, Presets: map[string]Entry{}}
	for _, a := range Defaults().Agents {
		s.Presets[a.ID] = a
	}
	if e.current != nil {
		s.Running = e.current.ID
	}
	for _, r := range e.runs {
		copy := *r
		copy.Log = redact(copy.Log, e.config)
		copy.Text = redact(copy.Text, e.config)
		copy.Error = redact(copy.Error, e.config)
		s.Runs = append(s.Runs, copy)
	}
	return s
}
func (e *Engine) Save(raw json.RawMessage) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active || e.current != nil {
		return errors.New("Stop the transport before changing the patch.")
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if _, ok := fields["token"]; !ok {
		c.Token = e.config.Token
	}
	if err := Validate(c); err != nil {
		return err
	}
	c.URL = strings.TrimRight(c.URL, "/")
	c.HasToken = false
	if err := writePrivate(filepath.Join(e.directory, "config.json"), c); err != nil {
		return err
	}
	e.config = c
	return nil
}
func (e *Engine) persistLocked() error {
	return writePrivate(filepath.Join(e.directory, "history.json"), e.runs)
}
func (e *Engine) clearTimerLocked() {
	e.generation++
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	e.nextAt = 0
}
func (e *Engine) scheduleLocked() {
	e.clearTimerLocked()
	if !e.active || e.current != nil || e.closing {
		return
	}
	d := interval(e.config.Schedule)
	e.nextAt = time.Now().Add(d).UnixMilli()
	generation := e.generation
	e.timer = time.AfterFunc(d, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if !e.active || generation != e.generation || e.current != nil {
			return
		}
		if err := e.launchLocked(); err != nil {
			e.active = false
			e.clearTimerLocked()
		}
	})
}
func (e *Engine) Start() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.checkLocked(); err != nil {
		return err
	}
	e.active = true
	e.scheduleLocked()
	return nil
}
func (e *Engine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.active = false
	e.clearTimerLocked()
	if e.cancel != nil {
		e.cancel()
	}
}
func (e *Engine) Close() {
	e.mu.Lock()
	e.closing = true
	e.active = false
	e.clearTimerLocked()
	if e.cancel != nil {
		e.cancel()
	}
	done := e.done
	e.mu.Unlock()
	if done != nil {
		<-done
	}
}
func (e *Engine) Launch() error { e.mu.Lock(); defer e.mu.Unlock(); return e.launchLocked() }
func (e *Engine) launchLocked() error {
	if e.current != nil {
		return errors.New("An agent is already running. Wait or hit STOP.")
	}
	if err := e.checkLocked(); err != nil {
		return err
	}
	c := cloneConfig(e.config)
	a := availability(c)
	agent, _ := choose(c.Agents, c.Selection.Agent, a["agents"])
	space, _ := choose(c.Spaces, c.Selection.Space, a["spaces"])
	persona, _ := choose(c.Personalities, c.Selection.Personality, nil)
	e.clearTimerLocked()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(c.Schedule.Timeout)*time.Second)
	r := &Run{ID: uuid(), StartedAt: time.Now().UnixMilli(), Status: "running", Agent: agent.Name, Space: space.Name, Path: space.Path, Personality: persona.Name, Color: persona.Color, DryRun: c.DryRun}
	e.current = r
	e.cancel = cancel
	e.done = make(chan struct{})
	e.runs = append([]*Run{r}, e.runs...)
	if len(e.runs) > 100 {
		e.runs = e.runs[:100]
	}
	go e.execute(ctx, cancel, e.done, c, agent, space, persona, r)
	return nil
}
func (e *Engine) board(ctx context.Context, c Config, path string, body any, out any) error {
	var reader io.Reader
	method := "GET"
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(b))
		method = "POST"
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("Slopchan returned HTTP %d.", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 16*1024*1024+1))
	if err != nil {
		return err
	}
	if len(b) > 16*1024*1024 {
		return errors.New("Board response too large.")
	}
	return json.Unmarshal(b, out)
}
func (e *Engine) TestBoard() (string, error) {
	e.mu.Lock()
	c := cloneConfig(e.config)
	e.mu.Unlock()
	var index boardIndex
	if err := e.board(context.Background(), c, "/api/threads?page=1", nil, &index); err != nil {
		return "", err
	}
	if index.Threads == nil {
		return "", errors.New("This URL did not return a slopchan board.")
	}
	return fmt.Sprintf("Board online · %d threads on page 1. Reads are public; token is checked when posting.", len(index.Threads)), nil
}

type post struct {
	ID   int64  `json:"id"`
	Text string `json:"text"`
}
type thread struct {
	ID    int64  `json:"id"`
	Full  bool   `json:"full"`
	Posts []post `json:"posts"`
}
type boardIndex struct {
	Threads []thread `json:"threads"`
}

func clipped(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (e *Engine) execute(ctx context.Context, cancel context.CancelFunc, done chan struct{}, c Config, agent, space, persona Entry, r *Run) {
	defer cancel()
	err := e.perform(ctx, c, agent, space, persona, r)
	e.mu.Lock()
	defer e.mu.Unlock()
	if err != nil {
		r.Status = "failed"
		r.Error = redact(err.Error(), c)
		if ctx.Err() != nil {
			r.Status = "cancelled"
			r.Error = "Stopped by user."
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				r.Error = fmt.Sprintf("Agent timed out after %d seconds.", c.Schedule.Timeout)
			}
		}
		if r.Text != "" && !c.DryRun {
			r.Error += " Delivery may be uncertain. Check the board before retrying."
		}
	}
	r.EndedAt = time.Now().UnixMilli()
	r.Log = redact(r.Log, c)
	e.current = nil
	e.cancel = nil
	e.done = nil
	if err := e.persistLocked(); err != nil {
		e.active = false
		r.Error += " Cannot save history: " + err.Error()
	}
	e.scheduleLocked()
	close(done)
}
func (e *Engine) perform(ctx context.Context, c Config, agent, space, persona Entry, r *Run) error {
	e.mu.Lock()
	err := e.persistLocked()
	e.mu.Unlock()
	if err != nil {
		return err
	}
	contextPosts := []any{}
	var reply int64
	var index boardIndex
	err = e.board(ctx, c, "/api/threads?page=1", nil, &index)
	if err == nil && index.Threads == nil {
		err = errors.New("URL did not return a slopchan board.")
	}
	if err == nil {
		for _, t := range index.Threads[:min(8, len(index.Threads))] {
			for i := range t.Posts {
				t.Posts[i].Text = clipped(t.Posts[i].Text, 1500)
			}
			contextPosts = append(contextPosts, map[string]any{"id": t.ID, "posts": t.Posts})
		}
		if c.Posting == "reply" || (c.Posting == "mixed" && randv2.Float64() < 0.65) {
			candidates := []thread{}
			for _, t := range index.Threads {
				if !t.Full {
					candidates = append(candidates, t)
				}
			}
			if len(candidates) > 0 {
				reply = candidates[randv2.IntN(min(5, len(candidates)))].ID
				var full thread
				err = e.board(ctx, c, fmt.Sprintf("/api/threads/%d", reply), nil, &full)
				if err == nil {
					posts := full.Posts[max(0, len(full.Posts)-15):]
					for i := range posts {
						posts[i].Text = clipped(posts[i].Text, 1500)
					}
					contextPosts = append([]any{map[string]any{"replyingTo": reply, "posts": posts}}, contextPosts...)
				}
			}
		}
	}
	if err != nil {
		if !c.DryRun || ctx.Err() != nil {
			return err
		}
		e.mu.Lock()
		r.Log = redact("Board context unavailable: "+err.Error()+"\nPreviewing without board context.\n", c)
		e.mu.Unlock()
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	r.Thread = reply
	e.mu.Unlock()
	dir, err := os.MkdirTemp("", "trashposter-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	output := filepath.Join(dir, "post.txt")
	prompt := buildPrompt(c, space, persona, contextPosts, reply)
	args := []string{}
	hasPrompt := false
	for _, a := range agent.Args {
		hasPrompt = hasPrompt || strings.Contains(a, "{prompt}")
		args = append(args, strings.ReplaceAll(strings.ReplaceAll(a, "{output}", output), "{prompt}", prompt))
	}
	args = explorationArgs(agent.Command, args, c.URL)
	if agent.Delivery == "argv" && !hasPrompt {
		args = append(args, prompt)
	}
	processCtx, processCancel := context.WithCancel(ctx)
	defer processCancel()
	cmd := exec.CommandContext(processCtx, executable(agent.Command), args...)
	cmd.Dir = ExpandPath(space.Path)
	env := map[string]string{}
	for _, v := range os.Environ() {
		k, value, _ := strings.Cut(v, "=")
		env[k] = value
	}
	for k, v := range agent.Env {
		env[k] = v
	}
	for _, k := range []string{"SLOPCHAN_TOKEN", "SLOPCHAN_TOKENS", "SLOPCHAN_TOKEN_FILE"} {
		delete(env, k)
	}
	env["TRASHPOSTER_RUN_ID"] = r.ID
	env["TRASHPOSTER_SPACE"] = space.Name
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if agent.Delivery == "stdin" {
		cmd.Stdin = strings.NewReader(prompt)
	}
	e.mu.Lock()
	initialLog := r.Log
	e.mu.Unlock()
	capture := &capture{engine: e, run: r, config: c, cancel: processCancel, combined: initialLog}
	cmd.Stdout = streamWriter{capture, true}
	cmd.Stderr = streamWriter{capture, false}
	configureProcess(cmd)
	err = cmd.Run()
	if capture.exceeded {
		return errors.New("Agent output exceeded 1 MB.")
	}
	if err != nil {
		return fmt.Errorf("Agent failed: %w. See its session log.", err)
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	text := capture.stdout.String()
	if agent.Output == "file" {
		f, err := os.Open(output)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(f, 1000001))
		f.Close()
		if err != nil {
			return err
		}
		text = string(b)
	}
	text = strings.TrimSpace(text)
	if !utf8.ValidString(text) || text == "" || utf8.RuneCountInString(text) > 10000 {
		return errors.New("Agent must return between 1 and 10,000 Unicode characters of post text.")
	}
	if redact(text, c) != text {
		return errors.New("Output contained a configured secret. Posting blocked.")
	}
	e.mu.Lock()
	r.Text = text
	if c.DryRun {
		r.Status = "preview"
		e.mu.Unlock()
		return nil
	}
	r.Status = "posting"
	err = e.persistLocked()
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	path := "/api/threads"
	if reply != 0 {
		path = fmt.Sprintf("/api/threads/%d/posts", reply)
	}
	var result struct {
		Post post `json:"post"`
	}
	if err = e.board(ctx, c, path, map[string]string{"text": text}, &result); err != nil {
		return err
	}
	if result.Post.ID == 0 {
		return errors.New("The board did not confirm a post ID. Inspect the board before retrying.")
	}
	e.mu.Lock()
	r.PostID = result.Post.ID
	r.PostURL = fmt.Sprintf("%s/posts/%d", c.URL, r.PostID)
	r.Status = "posted"
	e.mu.Unlock()
	return nil
}

type capture struct {
	mu       sync.Mutex
	engine   *Engine
	run      *Run
	config   Config
	stdout   strings.Builder
	combined string
	exceeded bool
	cancel   context.CancelFunc
}
type streamWriter struct {
	c      *capture
	stdout bool
}

func (w streamWriter) Write(p []byte) (int, error) {
	c := w.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if w.stdout {
		if c.stdout.Len()+len(p) > 1000000 {
			c.exceeded = true
			c.cancel()
		} else {
			c.stdout.Write(p)
		}
	}
	c.combined += string(p)
	if len(c.combined) > 64000 {
		c.combined = c.combined[len(c.combined)-64000:]
	}
	c.engine.mu.Lock()
	c.run.Log = redact(c.combined, c.config)
	c.engine.mu.Unlock()
	return len(p), nil
}
