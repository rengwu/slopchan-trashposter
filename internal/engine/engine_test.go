package engine

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Use the test binary itself as a disposable CLI, with no paid model or live board.
func TestAgentProcess(t *testing.T) {
	if os.Getenv("TRASHPOSTER_TEST_AGENT") != "test-helper-enabled" {
		return
	}
	mode := ""
	for i, a := range os.Args {
		if a == "--" {
			mode = os.Args[i+1]
			break
		}
	}
	switch mode {
	case "wait":
		time.Sleep(30 * time.Second)
	case "fail":
		os.Exit(2)
	case "empty":
	case "secret":
		fmt.Print("test-secret-bearer")
	case "flood":
		fmt.Print(strings.Repeat("x", 1000100))
	case "context":
		b, _ := io.ReadAll(os.Stdin)
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"cwd": cwd, "prompt": string(b), "token": os.Getenv("SLOPCHAN_TOKEN")})
	case "file":
		_ = os.WriteFile(os.Args[len(os.Args)-1], []byte("the actual post"), 0600)
		fmt.Print("telemetry only")
	case "argv":
		if strings.Contains(os.Args[len(os.Args)-1], "$(touch do-not-create)") {
			fmt.Print("literal argument")
		}
	default:
		fmt.Print("a tiny useful observation")
	}
	os.Exit(0)
}

type boardFixture struct {
	mu     sync.Mutex
	writes int
	paths  []string
	auth   string
	fail   bool
}

func fixture(t *testing.T, mode string, live bool) (*Engine, *boardFixture) {
	t.Helper()
	b := &boardFixture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.paths = append(b.paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			b.writes++
			b.auth = r.Header.Get("Authorization")
			if b.fail {
				http.Error(w, "failed", 500)
				return
			}
			fmt.Fprint(w, `{"post":{"id":42}}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/7") {
			fmt.Fprint(w, `{"id":7,"posts":[{"id":7,"text":"the selected discussion"}]}`)
			return
		}
		fmt.Fprint(w, `{"threads":[{"id":7,"full":false,"posts":[{"id":7,"text":"recent context"}]}]}`)
	}))
	t.Cleanup(server.Close)
	directory := t.TempDir()
	e, err := New(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	executable, _ := os.Executable()
	c := e.config
	c.URL = server.URL
	c.DryRun = !live
	c.Token = "test-secret-bearer"
	c.Posting = "thread"
	c.Agents = []Entry{{ID: "test", Name: "Test agent", Enabled: true, Command: executable, Args: []string{"-test.run=^TestAgentProcess$", "--", mode}, Delivery: "stdin", Output: "stdout", Env: map[string]string{"TRASHPOSTER_TEST_AGENT": "test-helper-enabled"}}}
	c.Spaces = []Entry{{ID: "test", Name: "Test workspace", Path: directory, Enabled: true}}
	c.Selection = Selection{"test", "test", "lurker"}
	if mode == "file" {
		c.Agents[0].Output = "file"
		c.Agents[0].Args = append(c.Agents[0].Args, "{output}")
	}
	saveConfig(t, e, c)
	return e, b
}
func saveConfig(t *testing.T, e *Engine, c Config) {
	t.Helper()
	b, _ := json.Marshal(c)
	if err := e.Save(b); err != nil {
		t.Fatal(err)
	}
}
func waitRun(t *testing.T, e *Engine) Run {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s := e.State()
		if s.Running == "" && len(s.Runs) > 0 {
			return s.Runs[0]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run did not finish")
	return Run{}
}
func launch(t *testing.T, e *Engine) Run {
	t.Helper()
	if err := e.Launch(); err != nil {
		t.Fatal(err)
	}
	return waitRun(t, e)
}
func TestPreviewContext(t *testing.T) {
	t.Setenv("SLOPCHAN_TOKEN", "inherited-secret")
	e, b := fixture(t, "context", false)
	r := launch(t, e)
	if r.Status != "preview" {
		t.Fatalf("%+v", r)
	}
	var output map[string]string
	if err := json.Unmarshal([]byte(r.Text), &output); err != nil {
		t.Fatal(err)
	}
	dir, _ := filepath.EvalSymlinks(e.directory)
	if output["cwd"] != dir || output["token"] != "" || !strings.Contains(output["prompt"], "recent context") || !strings.Contains(output["prompt"], "Internet cryptid") || strings.Contains(output["prompt"], e.config.Token) {
		t.Fatalf("bad prompt context: %+v", output)
	}
	if b.writes != 0 {
		t.Fatal("preview posted")
	}
}
func TestDelivery(t *testing.T) {
	for _, mode := range []string{"stdout", "file", "argv"} {
		t.Run(mode, func(t *testing.T) {
			e, b := fixture(t, mode, true)
			c := e.config
			c.Posting = "reply"
			if mode == "argv" {
				c.Agents[0].Delivery = "argv"
				c.Prompt = "$(touch do-not-create)"
			}
			saveConfig(t, e, c)
			r := launch(t, e)
			if r.Status != "posted" || r.PostID != 42 || r.Thread != 7 || b.writes != 1 || b.auth != "Bearer test-secret-bearer" {
				t.Fatalf("%+v, %+v", r, b)
			}
			if mode == "file" && r.Text != "the actual post" {
				t.Fatal(r.Text)
			}
			if mode == "argv" && r.Text != "literal argument" {
				t.Fatal(r.Text)
			}
			if !strings.Contains(strings.Join(b.paths, ","), "/api/threads/7/posts") {
				t.Fatal(b.paths)
			}
		})
	}
}
func TestFailuresNeverPost(t *testing.T) {
	for _, mode := range []string{"fail", "empty", "secret", "flood"} {
		t.Run(mode, func(t *testing.T) {
			e, b := fixture(t, mode, true)
			r := launch(t, e)
			if r.Status != "failed" || b.writes != 0 || strings.Contains(r.Log, "test-secret-bearer") {
				t.Fatalf("%+v", r)
			}
		})
	}
}
func TestCancelAndLock(t *testing.T) {
	e, b := fixture(t, "wait", true)
	if err := e.Launch(); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(); err == nil {
		t.Fatal("overlap accepted")
	}
	raw, _ := json.Marshal(e.config)
	if err := e.Save(raw); err == nil {
		t.Fatal("saved during run")
	}
	time.Sleep(100 * time.Millisecond)
	e.Stop()
	r := waitRun(t, e)
	if r.Status != "cancelled" || b.writes != 0 || e.State().NextAt != 0 {
		t.Fatalf("%+v", r)
	}
}
func TestTimeout(t *testing.T) {
	e, b := fixture(t, "wait", true)
	c := e.config
	c.Schedule.Timeout = 5
	saveConfig(t, e, c)
	r := launch(t, e)
	if r.Status != "cancelled" || !strings.Contains(r.Error, "timed out") || b.writes != 0 {
		t.Fatalf("%+v", r)
	}
}
func TestUncertainWriteNeverRetries(t *testing.T) {
	e, b := fixture(t, "stdout", true)
	b.fail = true
	r := launch(t, e)
	if b.writes != 1 || r.Status != "failed" || !strings.Contains(r.Error, "uncertain") {
		t.Fatalf("%+v", r)
	}
}
func TestPersistenceAndToken(t *testing.T) {
	e, _ := fixture(t, "stdout", false)
	launch(t, e)
	s := e.State()
	if s.Config.Token != "" || !s.Config.HasToken {
		t.Fatal("token exposed")
	}
	saveConfig(t, e, s.Config)
	if e.config.Token != "test-secret-bearer" {
		t.Fatal("token lost")
	}
	if err := e.Start(); err != nil {
		t.Fatal(err)
	}
	next, err := New(e.directory)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if next.State().Active || len(next.State().Runs) != 1 {
		t.Fatal("bad restart")
	}
	for _, name := range []string{"config.json", "history.json"} {
		info, err := os.Stat(filepath.Join(e.directory, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("storage not private")
		}
	}
	c := s.Config
	c.Token = ""
	raw, _ := json.Marshal(c)
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	fields["token"] = ""
	raw, _ = json.Marshal(fields)
	e.Stop()
	if err = e.Save(raw); err != nil {
		t.Fatal(err)
	}
	if e.State().Config.HasToken {
		t.Fatal("clear failed")
	}
}
func TestSelectionAndClock(t *testing.T) {
	c := Defaults()
	for i := 0; i < 100; i++ {
		d := interval(c.Schedule)
		if d < 180*time.Second || d > 900*time.Second {
			t.Fatal(d)
		}
	}
	c.Schedule.Mode = "fixed"
	if interval(c.Schedule) != 300*time.Second {
		t.Fatal("fixed interval")
	}
	if _, err := choose(c.Agents, "missing", nil); err == nil {
		t.Fatal("invalid selection")
	}
	e, _ := fixture(t, "stdout", false)
	if err := e.Start(); err != nil {
		t.Fatal(err)
	}
	if e.State().NextAt <= time.Now().UnixMilli() {
		t.Fatal("clock not armed")
	}
	launch(t, e)
	if !e.State().Active || e.State().NextAt == 0 {
		t.Fatal("one-shot did not rearm")
	}
	e.Stop()
	if e.State().NextAt != 0 {
		t.Fatal("clock not stopped")
	}
}
func TestValidation(t *testing.T) {
	for _, mutate := range []func(*Config){func(c *Config) { c.Schedule.Min = 0 }, func(c *Config) { c.Selection.Agent = "missing" }, func(c *Config) { c.Agents[0].Args = nil }, func(c *Config) { c.Agents[0].Env = nil }, func(c *Config) { c.URL = "https://user:pass@example.com" }, func(c *Config) { c.Spaces[0].Path = "relative" }} {
		c := Defaults()
		mutate(&c)
		if Validate(c) == nil {
			t.Fatal("invalid config accepted")
		}
	}
}
func TestReader(t *testing.T) {
	e, b := fixture(t, "stdout", false)
	input := strings.NewReader("{bad\n" + `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_thread","arguments":{"id":7}}}` + "\n" + `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"publish","arguments":{}}}` + "\n")
	var out strings.Builder
	if err := ServeReader(e.config.URL, input, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "the selected discussion") || !strings.Contains(out.String(), "Only public board reads") || b.writes != 0 {
		t.Fatal(out.String())
	}
	if _, err := readPath("read_post", map[string]any{"id": 1.5}); err == nil {
		t.Fatal("fraction accepted")
	}
	if _, err := readPath("list_threads", map[string]any{"token": "x"}); err == nil {
		t.Fatal("unknown argument accepted")
	}
	args := explorationArgs("codex", []string{"exec"}, e.config.URL)
	if !strings.Contains(strings.Join(args, " "), "--board-reader") {
		t.Fatal(args)
	}
}

func TestCloseCancelsAndPersists(t *testing.T) {
	e, b := fixture(t, "wait", true)
	if err := e.Launch(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	e.Close()
	s := e.State()
	if s.Running != "" || s.Active || s.Runs[0].Status != "cancelled" || b.writes != 0 {
		t.Fatalf("shutdown left work active: %+v", s.Runs)
	}
	next, err := New(e.directory)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if next.State().Runs[0].Status != "cancelled" {
		t.Fatal("shutdown not persisted")
	}
	if err = e.Launch(); err == nil {
		t.Fatal("closed engine accepted work")
	}
}
