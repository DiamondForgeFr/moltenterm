// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	// How much of a transcript's start discovery reads to learn its folder and start time.
	headReadBytes = 1024 * 1024
	headMaxLines  = 200
	// Codex's session_meta carries the base instructions: tens of KB.
	headLineMax = 512 * 1024
	// A session modified this long before the agent started cannot be this run's.
	startSlack = 2 * time.Second
)

// Adapter reads one agent's transcripts (DS-SHELL-019). Adapters are the future mod surface for other agents.
type Adapter interface {
	Id() string
	// Roots: the folders the agent's sessions live in; only files under them are ever opened.
	Roots() []string
	// ValidLayout checks a path relative to a root has the shape of a session file of this agent.
	ValidLayout(rel string) bool
	// Discover lists the sessions of a folder modified since the agent started, newest first.
	Discover(cwd string, since time.Time) []Candidate
	// Parse reads one record into the session; it tells whether the record is one the adapter knows.
	Parse(rec map[string]any, s *Session) bool
}

// SessionFinder is an adapter that resolves one of its sessions' transcripts from the session id an agent reports
// (Codex's notify payload). The path it returns is still validated like any reported path.
type SessionFinder interface {
	FindSession(id string) (string, bool)
	// SessionMatches tells whether a transcript path is the one of a session id, without reading anything.
	SessionMatches(path string, id string) bool
	// IsSubagent tells whether a transcript is a sub-agent's (or a reviewer's), which no pane is linked to.
	IsSubagent(path string) bool
}

// SettingsReader is an adapter whose agent writes its run's model and effort level only in its transcript (#549).
type SettingsReader interface {
	// ReadSettings reads them from the end of a transcript; false when it holds none.
	ReadSettings(path string) (molten.AgentSettings, bool)
}

// SessionNamer is an adapter whose agent keeps its sessions' names outside the transcript (Codex's session index):
// the name is read for the session shown, like a name its transcript records (#991).
type SessionNamer interface {
	// SessionName gives the agent's current name of a session; false when it has none.
	SessionName(sessionPath string, id string) (string, bool)
}

// SubagentWriter is an adapter whose background agents write transcripts of their own, next to their session's:
// when one was last written tells whether the agent still works when its end was never recorded.
type SubagentWriter interface {
	// SubagentWritten: when the agent last wrote its transcript, in Unix milliseconds; 0 when it has none.
	SubagentWritten(sessionPath string, agentId string) int64
}

// SubagentReader is an adapter whose sub-agents' own transcripts say their model, effort and branch (#601).
type SubagentReader interface {
	// SubagentIds maps the calls that started sub-agents to the agents' ids, for the agents whose call result did not
	// give it yet (a foreground agent's comes with its end).
	SubagentIds(sessionPath string) map[string]string
	// ReadSubagent reads the latest facts of a sub-agent's transcript; false when it has none.
	ReadSubagent(sessionPath string, agentId string) (SubagentFacts, bool)
}

// SubagentFinder is an adapter whose sub-agents' transcripts name their parent, so the sub-agents a sub-agent starts
// (which its parent's transcript never records) are found by their own (#986).
type SubagentFinder interface {
	// FindSubagents lists the agents whose parent is one of parents, started since the given time (Unix ms).
	FindSubagents(sessionPath string, parents []string, since int64) []FoundSubagent
}

// FoundSubagent is an agent its own transcript describes.
type FoundSubagent struct {
	AgentId  string
	ParentId string
	Path     string
	// Name: its task in readable form, else its nickname.
	Name    string
	Kind    string
	Started int64
	// Nested: started by a sub-agent, not by the session.
	Nested bool
}

// SubagentFacts is what a sub-agent's own transcript last says of it.
type SubagentFacts struct {
	Model  string
	Effort string
	Branch string
	// Worktree: the folder it works in, its branch's (#1035).
	Worktree string
	// Ended: its latest turn ended (Codex); only an agent found by its transcript takes its state from it.
	Ended bool
}

// Candidate is a session discovery found for a block.
type Candidate struct {
	Path     string `json:"path"`
	Id       string `json:"id,omitempty"`
	Started  int64  `json:"started,omitempty"`
	Modified int64  `json:"modified,omitempty"`
	// Prompt: the session's first prompt, cut short, to tell sessions apart in the picker (shown locally only).
	Prompt string `json:"prompt,omitempty"`
	// Command: the first slash command of the session ("/clear"), the title while there is no prompt yet.
	Command string `json:"command,omitempty"`
	// Current: the session this terminal's companion shows now (the history lists it first).
	Current bool `json:"current,omitempty"`
	// Elsewhere: another terminal's companion shows it as a guess; picking it here takes it.
	Elsewhere bool `json:"elsewhere,omitempty"`
	// Earlier: a session this terminal showed before its current one (#600).
	Earlier bool `json:"earlier,omitempty"`
	// Live: the session the agent runs now, while the companion shows an earlier one.
	Live bool `json:"live,omitempty"`
	cwd  string
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// AdapterFor returns the adapter of an agent id, or nil when no companion exists for it.
func AdapterFor(agent string) Adapter {
	switch agent {
	case molten.AgentIdClaude:
		return MakeClaudeAdapter(nil)
	case molten.AgentIdCodex:
		return MakeCodexAdapter(nil)
	}
	return nil
}

// SupportedAgents are the agents with a companion.
var SupportedAgents = []string{molten.AgentIdClaude, molten.AgentIdCodex}

// ValidateSessionPath accepts a transcript path only when it is a regular .jsonl file under one of the adapter's
// roots, symlinks resolved on both sides (no escape through a link), in the adapter's layout. It returns the
// resolved path.
func ValidateSessionPath(a Adapter, path string) (string, error) {
	if path == "" || len(path) > MaxPathBytes || strings.ContainsRune(path, 0) {
		return "", fmt.Errorf("invalid session path")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("the session path must be absolute")
	}
	if !strings.HasSuffix(path, ".jsonl") {
		return "", fmt.Errorf("not a session transcript (.jsonl)")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("session transcript not found")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("session transcript is not a regular file")
	}
	for _, root := range a.Roots() {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(realRoot, resolved)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			continue
		}
		if a.ValidLayout(filepath.ToSlash(rel)) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("the session transcript is not under %s's session folder", a.Id())
}

// ValidateReportedSessionPath is ValidateSessionPath for a hook's report, which may come before the transcript exists:
// Claude Code runs SessionStart (after /clear too) before it writes the new session's first record. A missing file
// is accepted when its folder passes the same checks; pending then tells the companion to wait for it.
func ValidateReportedSessionPath(a Adapter, path string) (resolved string, pending bool, err error) {
	resolved, err = ValidateSessionPath(a, path)
	if err == nil {
		return resolved, false, nil
	}
	if path == "" || len(path) > MaxPathBytes || strings.ContainsRune(path, 0) || !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") {
		return "", false, err
	}
	clean := filepath.Clean(path)
	if _, statErr := os.Lstat(clean); !errors.Is(statErr, fs.ErrNotExist) {
		return "", false, err
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(clean))
	if err != nil {
		return "", false, fmt.Errorf("session folder not found")
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", false, fmt.Errorf("session folder not found")
	}
	resolved = filepath.Join(dir, filepath.Base(clean))
	for _, root := range a.Roots() {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(realRoot, resolved)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			continue
		}
		if a.ValidLayout(filepath.ToSlash(rel)) {
			return resolved, true, nil
		}
	}
	return "", false, fmt.Errorf("the session transcript is not under %s's session folder", a.Id())
}

// samePath compares two folders, symlinks resolved when they exist (/tmp and /private/tmp on macOS).
func samePath(a string, b string) bool {
	if a == "" || b == "" {
		return false
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

// readHead reads the first records of a transcript (complete lines only), for discovery.
func readHead(path string, maxLines int) []map[string]any {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	reader := bufio.NewReaderSize(io.LimitReader(f, headReadBytes), headLineMax)
	var rtn []map[string]any
	for len(rtn) < maxLines {
		line, err := reader.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// A long record (a tool result): skip it.
			for err == bufio.ErrBufferFull {
				_, err = reader.ReadSlice('\n')
			}
			continue
		}
		if err != nil {
			break
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) == nil {
			rtn = append(rtn, rec)
		}
	}
	return rtn
}

// JSON helpers: transcripts are read as loose maps so a field that changes type or disappears is skipped, never fatal.

func str(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func obj(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func arr(m map[string]any, key string) []any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].([]any); ok {
		return v
	}
	return nil
}

func boolean(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	v, _ := m[key].(bool)
	return v
}

func num(m map[string]any, key string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	v, ok := m[key].(float64)
	return v, ok
}

func asObj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// compactJSON renders a value for display: strings as they are, the rest as compact JSON.
func compactJSON(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	out, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(out)
}

const argStringMax = 300

// argsJSON renders a tool call's arguments for display, each long string cut first: a Write's whole file content is
// neither marshalled nor kept.
func argsJSON(v any) string {
	return compactJSON(shortenStrings(v, 0))
}

func shortenStrings(v any, depth int) any {
	if depth > 8 {
		return nil
	}
	switch val := v.(type) {
	case string:
		if len(val) > argStringMax {
			return cutString(val, argStringMax) + "…"
		}
		return val
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			out[k] = shortenStrings(item, depth+1)
		}
		return out
	case []any:
		if len(val) > 50 {
			val = val[:50]
		}
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = shortenStrings(item, depth+1)
		}
		return out
	}
	return v
}

// parseTime reads an RFC 3339 timestamp into Unix milliseconds (0 when absent or malformed).
func parseTime(value string) int64 {
	if value == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// contentDiff renders a whole new file as one hunk of added lines.
func contentDiff(content string) string {
	if content == "" {
		return ""
	}
	content = cutString(content, MaxDiffBytes)
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	var b strings.Builder
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteString("+")
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// hunksDiff renders structured hunks ({oldStart, oldLines, newStart, newLines, lines}) as unified diff text.
func hunksDiff(hunks []any) string {
	var b strings.Builder
	for _, h := range hunks {
		hunk := asObj(h)
		if hunk == nil {
			continue
		}
		oldStart, _ := num(hunk, "oldStart")
		oldLines, _ := num(hunk, "oldLines")
		newStart, _ := num(hunk, "newStart")
		newLines, _ := num(hunk, "newLines")
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", int(oldStart), int(oldLines), int(newStart), int(newLines))
		for _, l := range arr(hunk, "lines") {
			if b.Len() > MaxDiffBytes {
				return b.String()
			}
			if line, ok := l.(string); ok {
				b.WriteString(line)
				b.WriteString("\n")
			}
		}
	}
	return b.String()
}
