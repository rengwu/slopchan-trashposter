package engine

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

//go:embed defaults.json
var defaultsFS embed.FS

type Entry struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Enabled  bool              `json:"enabled"`
	Command  string            `json:"command,omitempty"`
	Args     []string          `json:"args"`
	Env      map[string]string `json:"env"`
	Delivery string            `json:"delivery,omitempty"`
	Output   string            `json:"output,omitempty"`
	Path     string            `json:"path,omitempty"`
	Prompt   string            `json:"prompt,omitempty"`
	Color    string            `json:"color,omitempty"`
}
type Schedule struct {
	Mode     string `json:"mode"`
	Interval int    `json:"interval"`
	Min      int    `json:"min"`
	Max      int    `json:"max"`
	Timeout  int    `json:"timeout"`
}
type Selection struct {
	Agent       string `json:"agent"`
	Space       string `json:"space"`
	Personality string `json:"personality"`
}
type Config struct {
	Version       int       `json:"version"`
	URL           string    `json:"url"`
	Token         string    `json:"token,omitempty"`
	HasToken      bool      `json:"hasToken"`
	Prompt        string    `json:"prompt"`
	Schedule      Schedule  `json:"schedule"`
	Selection     Selection `json:"selection"`
	Posting       string    `json:"posting"`
	DryRun        bool      `json:"dryRun"`
	Agents        []Entry   `json:"agents"`
	Spaces        []Entry   `json:"spaces"`
	Personalities []Entry   `json:"personalities"`
}

func Defaults() Config {
	b, _ := defaultsFS.ReadFile("defaults.json")
	var c Config
	_ = json.Unmarshal(b, &c)
	return c
}
func ExpandPath(p string) string {
	h, _ := os.UserHomeDir()
	if p == "~" {
		return h
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(h, p[2:])
	}
	return p
}
func validateURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("Use an HTTP(S) board URL without credentials, query, or fragment.")
	}
	return nil
}

var idPattern = regexp.MustCompile(`^[\w-]{1,80}$`)
var envPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var colorPattern = regexp.MustCompile(`^#[\da-fA-F]{6}$`)

func Validate(c Config) error {
	if e := validateURL(c.URL); e != nil {
		return e
	}
	if len(c.Token) > 8192 || strings.ContainsAny(c.Token, "\r\n") {
		return fmt.Errorf("Invalid token.")
	}
	if utf8.RuneCountInString(c.Prompt) > 30000 {
		return fmt.Errorf("Core prompt must be at most 30,000 characters.")
	}
	s := c.Schedule
	if s.Mode != "fixed" && s.Mode != "random" {
		return fmt.Errorf("Choose a valid clock mode.")
	}
	for k, v := range map[string]int{"interval": s.Interval, "min": s.Min, "max": s.Max, "timeout": s.Timeout} {
		min := 10
		if k == "timeout" {
			min = 5
		}
		if v < min || v > 86400 {
			return fmt.Errorf("%s: use whole seconds between %d and 86400.", k, min)
		}
	}
	if s.Min > s.Max {
		return fmt.Errorf("Minimum interval cannot exceed maximum.")
	}
	if c.Posting != "thread" && c.Posting != "reply" && c.Posting != "mixed" {
		return fmt.Errorf("Invalid posting mode.")
	}
	for group, items := range map[string][]Entry{"agents": c.Agents, "spaces": c.Spaces, "personalities": c.Personalities} {
		if items == nil || len(items) > 100 {
			return fmt.Errorf("Provide an array of at most 100 %s.", group)
		}
		ids := map[string]bool{}
		for _, v := range items {
			if !idPattern.MatchString(v.ID) || ids[v.ID] {
				return fmt.Errorf("Invalid or duplicate %s ID.", group)
			}
			ids[v.ID] = true
			if strings.TrimSpace(v.Name) == "" || len(v.Name) > 100 {
				return fmt.Errorf("Give each %s entry a name (maximum 100 characters).", group)
			}
			switch group {
			case "agents":
				if strings.TrimSpace(v.Command) == "" || len(v.Command) > 4096 || strings.ContainsRune(v.Command, 0) {
					return fmt.Errorf("Agent executable is required.")
				}
				if v.Args == nil || len(v.Args) > 100 {
					return fmt.Errorf("Arguments must be a JSON array of at most 100 strings.")
				}
				outputArg := false
				for _, a := range v.Args {
					if len(a) > 30000 || strings.ContainsRune(a, 0) {
						return fmt.Errorf("Invalid agent argument.")
					}
					outputArg = outputArg || strings.Contains(a, "{output}")
				}
				if (v.Delivery != "stdin" && v.Delivery != "argv") || (v.Output != "stdout" && v.Output != "file") {
					return fmt.Errorf("Invalid prompt delivery or output mode.")
				}
				if v.Output == "file" && !outputArg {
					return fmt.Errorf("File output requires {output} in the arguments.")
				}
				if v.Env == nil {
					return fmt.Errorf("Environment must be a JSON object of string values.")
				}
				for k, value := range v.Env {
					if !envPattern.MatchString(k) || strings.ContainsRune(value, 0) {
						return fmt.Errorf("Invalid environment entry.")
					}
				}
			case "spaces":
				if !filepath.IsAbs(ExpandPath(v.Path)) || strings.ContainsRune(v.Path, 0) {
					return fmt.Errorf("Folder paths must be absolute (~/ is okay).")
				}
			case "personalities":
				if len(v.Prompt) > 20000 || !colorPattern.MatchString(v.Color) {
					return fmt.Errorf("Personality requires a prompt and hex color.")
				}
			}
		}
	}
	for key, pool := range map[string]struct {
		id    string
		items []Entry
	}{"agent": {c.Selection.Agent, c.Agents}, "space": {c.Selection.Space, c.Spaces}, "personality": {c.Selection.Personality, c.Personalities}} {
		if pool.id == "random" {
			continue
		}
		found := false
		for _, v := range pool.items {
			found = found || (v.ID == pool.id && v.Enabled)
		}
		if !found {
			return fmt.Errorf("Select an enabled %s, or shuffle.", key)
		}
	}
	return nil
}
func writePrivate(path string, value any) error {
	b, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".trashposter-*.tmp")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(append(b, '\n')); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
func cloneConfig(c Config) Config {
	b, _ := json.Marshal(c)
	var out Config
	_ = json.Unmarshal(b, &out)
	return out
}
