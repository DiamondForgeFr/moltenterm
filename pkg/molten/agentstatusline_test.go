// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The input's shape as https://code.claude.com/docs/en/statusline documents it.
const documentedStatusLineInput = `{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "model": {"id": "claude-opus-4-1", "display_name": "Opus"},
  "workspace": {"current_dir": "/w", "project_dir": "/w"},
  "rate_limits": {
    "five_hour": {"used_percentage": 23.5, "resets_at": 1738425600},
    "seven_day": {"used_percentage": 41.2, "resets_at": 1738857600},
    "spend_limit": {"used_percentage": 62.8, "resets_at": 1740787200, "used_usd": 314.12, "limit_usd": 500, "period": "monthly"}
  }
}`

func TestParseStatusLineInput(t *testing.T) {
	req, err := ParseStatusLineInput([]byte(documentedStatusLineInput))
	if err != nil || !req.RateLimits {
		t.Fatalf("documented input: %+v %v", req, err)
	}
	if *req.FiveHour != (StatusLineWindow{UsedPercent: 23.5, ResetsAt: 1738425600}) ||
		*req.SevenDay != (StatusLineWindow{UsedPercent: 41.2, ResetsAt: 1738857600}) ||
		*req.SpendLimit != (StatusLineWindow{UsedPercent: 62.8, ResetsAt: 1740787200}) {
		t.Errorf("windows: %+v %+v %+v", req.FiveHour, req.SevenDay, req.SpendLimit)
	}
	out, _ := json.Marshal(req)
	for _, kept := range []string{"abc123", "transcript", "Opus", "/w", "314", "monthly"} {
		if strings.Contains(string(out), kept) {
			t.Errorf("only the rate limit windows are sent, found %q in %s", kept, out)
		}
	}

	cases := map[string]struct {
		input      string
		err        bool
		rateLimits bool
		windows    bool
	}{
		"free plan, no rate_limits": {input: `{"session_id":"x"}`},
		"rate_limits null":          {input: `{"rate_limits":null}`},
		"one window only":           {input: `{"rate_limits":{"seven_day":{"used_percentage":5,"resets_at":1}}}`, rateLimits: true, windows: true},
		"mistyped window":           {input: `{"rate_limits":{"five_hour":{"used_percentage":"23%"}}}`, rateLimits: true},
		"missing percentage":        {input: `{"rate_limits":{"five_hour":{"resets_at":1}}}`, rateLimits: true},
		"rate_limits not an object": {input: `{"rate_limits":[1,2]}`, rateLimits: true},
		"not JSON":                  {input: `hello`, err: true},
		"a JSON array":              {input: `[]`, err: true},
		"empty":                     {input: ``, err: true},
	}
	for name, c := range cases {
		req, err := ParseStatusLineInput([]byte(c.input))
		if (err != nil) != c.err || req.RateLimits != c.rateLimits || req.HasWindows() != c.windows {
			t.Errorf("%s: %+v %v", name, req, err)
		}
	}
	req, _ = ParseStatusLineInput([]byte(`{"rate_limits":{"five_hour":{"used_percentage":12}}}`))
	if req.FiveHour == nil || req.FiveHour.ResetsAt != 0 {
		t.Errorf("a window without its reset keeps its percent: %+v", req.FiveHour)
	}
}

func TestStatusLineRelayCommand(t *testing.T) {
	if got := StatusLineRelayCommand(""); got != "command -v molten >/dev/null 2>&1 && exec molten agent statusline || true" {
		t.Errorf("no command: %s", got)
	}
	got := StatusLineRelayCommand(`~/.claude/statusline.sh`)
	if got != `command -v molten >/dev/null 2>&1 && exec molten agent statusline -- '~/.claude/statusline.sh'; ~/.claude/statusline.sh` {
		t.Errorf("script: %s", got)
	}
}

// Where molten is not on the PATH (another terminal app), the wrapped command prints exactly what the user's own
// command printed, from the same input, and exits with its code.
func TestWrappedStatusLineRunsUnchangedWithoutMolten(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	commands := []string{
		`jq -r '"[\(.model.display_name)] \(.context_window.used_percentage // 0)% context"'`,
		`input=$(cat); echo "it's $(printf '%s' "$input" | wc -c | tr -d ' ') bytes"; printf 'a\tb\n' | tr a z`,
		`cat; echo; echo "two" >&2; exit 3`,
		`printf '\033[32m%s\033[0m' ok`,
	}
	empty := t.TempDir()
	for _, c := range commands {
		if strings.HasPrefix(c, "jq") {
			if _, err := exec.LookPath("jq"); err != nil {
				continue
			}
		}
		run := func(cmd string) (string, string, int) {
			sh := exec.Command("/bin/sh", "-c", cmd)
			sh.Env = []string{"PATH=" + empty + ":/usr/bin:/bin", "HOME=" + empty}
			sh.Stdin = strings.NewReader(documentedStatusLineInput)
			var stdout, stderr bytes.Buffer
			sh.Stdout, sh.Stderr = &stdout, &stderr
			err := sh.Run()
			code := 0
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
			return stdout.String(), stderr.String(), code
		}
		o1, e1, c1 := run(c)
		o2, e2, c2 := run(StatusLineRelayCommand(c))
		if o1 != o2 || e1 != e2 || c1 != c2 {
			t.Errorf("%s:\nbefore %q %q %d\nafter  %q %q %d", c, o1, e1, c1, o2, e2, c2)
		}
	}
}

func TestClaudeStatusLineSetup(t *testing.T) {
	env := hookTestEnv(t)
	user := filepath.Join(env.Home, ".claude", "settings.json")

	s := ClaudeStatusLineSetup(env, "")
	if s.Configured || s.File != "~/.claude/settings.json" || s.Current != "" || s.Language != "json" {
		t.Errorf("no status line: %+v", s)
	}
	if !strings.Contains(s.Snippet, `"command": "command -v molten >/dev/null 2>&1 && exec molten agent statusline || true"`) {
		t.Errorf("no status line snippet:\n%s", s.Snippet)
	}

	writeTestFile(t, user, `{"model":"opus","statusLine":{"type":"command","command":"jq -r '.model.display_name'","padding":2,"refreshInterval":5}}`)
	s = ClaudeStatusLineSetup(env, "")
	if s.Configured || s.Current != `jq -r '.model.display_name'` {
		t.Fatalf("user status line: %+v", s)
	}
	var parsed struct {
		StatusLine map[string]any `json:"statusLine"`
	}
	if err := json.Unmarshal([]byte(s.Snippet), &parsed); err != nil {
		t.Fatalf("the snippet is JSON: %v\n%s", err, s.Snippet)
	}
	want := StatusLineRelayCommand(`jq -r '.model.display_name'`)
	if parsed.StatusLine["type"] != "command" || parsed.StatusLine["command"] != want ||
		parsed.StatusLine["padding"] != float64(2) || parsed.StatusLine["refreshInterval"] != float64(5) {
		t.Errorf("the snippet keeps the fields and wraps the command: %+v", parsed.StatusLine)
	}
	if strings.Contains(s.Snippet, `\u0026`) || !strings.HasPrefix(s.Snippet, "{\n  \"statusLine\": {\n    \"type\": \"command\",\n    \"command\": ") {
		t.Errorf("readable snippet:\n%s", s.Snippet)
	}

	// The project's status line wins over the user's; a local one over the shared one.
	repo := filepath.Join(env.Home, "repo")
	writeTestFile(t, filepath.Join(repo, ".git", "HEAD"), "ref")
	writeTestFile(t, filepath.Join(repo, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"shared"}}`)
	sub := filepath.Join(repo, "sub")
	os.MkdirAll(sub, 0755)
	if s := ClaudeStatusLineSetup(env, sub); s.Current != "shared" || s.File != "~/repo/.claude/settings.json" {
		t.Errorf("project: %+v", s)
	}
	writeTestFile(t, filepath.Join(repo, ".claude", "settings.local.json"), `{"statusLine":{"type":"command","command":"local"}}`)
	if s := ClaudeStatusLineSetup(env, sub); s.Current != "local" || s.File != "~/repo/.claude/settings.local.json" {
		t.Errorf("project local: %+v", s)
	}

	writeTestFile(t, user, `{"statusLine":{"type":"command","command":"`+strings.ReplaceAll(want, `"`, `\"`)+`"}}`)
	if s := ClaudeStatusLineSetup(env, ""); !s.Configured || s.Snippet != "" {
		t.Errorf("configured once the command runs the relay: %+v", s)
	}
	writeTestFile(t, user, `{"statusLine":{"command":"molten agent statusline -- x",}}`)
	if s := ClaudeStatusLineSetup(env, ""); !s.Configured {
		t.Errorf("a file that does not parse is searched as text: %+v", s)
	}
	writeTestFile(t, claudeManagedSettings(), `{"statusLine":{"type":"command","command":"managed"}}`)
	if s := ClaudeStatusLineSetup(env, ""); s.Configured || s.Current != "managed" {
		t.Errorf("the managed status line wins: %+v", s)
	}

	env.Getenv = func(name string) string {
		if name == "CLAUDE_CONFIG_DIR" {
			return filepath.Join(env.Home, "alt")
		}
		return ""
	}
	os.Remove(claudeManagedSettings())
	if s := ClaudeStatusLineSetup(env, ""); s.File != "~/alt/settings.json" || s.Current != "" {
		t.Errorf("CLAUDE_CONFIG_DIR: %+v", s)
	}
}

func TestClaudeStatusLineSetupNeverWrites(t *testing.T) {
	env := hookTestEnv(t)
	user := filepath.Join(env.Home, ".claude", "settings.json")
	content := `{"statusLine":{"type":"command","command":"echo hi"}}`
	writeTestFile(t, user, content)
	info, _ := os.Stat(user)
	ClaudeStatusLineSetup(env, env.Home)
	data, _ := os.ReadFile(user)
	after, _ := os.Stat(user)
	if string(data) != content || !after.ModTime().Equal(info.ModTime()) {
		t.Error("the settings file is never written")
	}
}
