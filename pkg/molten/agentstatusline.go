// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// Claude Code's status line relay (FR-SHELL-027, DS-SHELL-031): Claude Code runs the user's status line command with
// its session's JSON on stdin, whose documented rate_limits object gives the plan's 5-hour and 7-day windows
// (https://code.claude.com/docs/en/statusline). `molten agent statusline -- <command>` runs that command unchanged and
// hands only those windows, and the session's model and effort level for the pane header (#549), to wavesrv. MoltenTerm shows the settings to paste and never writes them.
// The relay's types and its reading of the input live in pkg/molten/agenthook, which the small molten program links
// without the rest of MoltenTerm (FR-PERF-012).

const (
	// What the snippet runs; a statusLine command that runs it is set up.
	agentStatusLineRelay = "molten agent statusline"
	// The relay reads at most this much of the status line input; the chained command still gets all of it.
	StatusLineMaxInput = agenthook.StatusLineMaxInput
)

type StatusLineWindow = agenthook.StatusLineWindow
type AgentStatusLineRequest = agenthook.AgentStatusLineRequest
type AgentStatusLineResponse = agenthook.AgentStatusLineResponse

// ParseStatusLineInput keeps the rate limit windows of Claude Code's status line input (agenthook.ParseStatusLineInput).
func ParseStatusLineInput(data []byte) (AgentStatusLineRequest, error) {
	return agenthook.ParseStatusLineInput(data)
}

// StatusLineSetup is what the companion shows to set the relay up, or that it is set up.
type StatusLineSetup struct {
	Configured bool `json:"configured"`
	// File: where the statusLine in effect lives, else the user's settings, shown with ~.
	File string `json:"file,omitempty"`
	// Current: the status line command in effect, empty when there is none.
	Current  string `json:"current,omitempty"`
	Language string `json:"language,omitempty"`
	Snippet  string `json:"snippet,omitempty"`
}

// claudeStatusLineFiles lists the settings that may hold the statusLine in effect for a session started in cwd, the
// one Claude Code applies first: managed, then the project's (local before shared, the nearest folder first), then
// the user's.
func claudeStatusLineFiles(env AgentEnv, cwd string) []string {
	files := []string{claudeManagedSettings()}
	all := claudeSettingsFiles(env, cwd)
	if len(all) > 3 {
		project := all[3:]
		for i := 0; i+1 < len(project); i += 2 {
			files = append(files, project[i+1], project[i])
		}
	}
	userDir := claudeConfigDir(env)
	return append(files, filepath.Join(userDir, "settings.local.json"), filepath.Join(userDir, "settings.json"))
}

// readStatusLine reads a settings file's statusLine object. found: the file sets one. A file that does not parse is
// searched as text for the relay: Claude Code may accept what this reader does not, and a false "set up" only hides
// the snippet.
func readStatusLine(path string) (map[string]any, bool, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false, false
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(data, &settings); err != nil {
		if strings.Contains(string(data), agentStatusLineRelay) {
			return nil, true, true
		}
		return nil, false, false
	}
	raw, ok := settings["statusLine"]
	if !ok {
		return nil, false, false
	}
	var line map[string]any
	if json.Unmarshal(raw, &line) != nil || line == nil {
		return nil, false, false
	}
	return line, true, false
}

// ClaudeStatusLineSetup reads, never writes, the statusLine in effect and builds the snippet that wraps its command
// in the relay, keeping its other fields.
func ClaudeStatusLineSetup(env AgentEnv, cwd string) StatusLineSetup {
	file := filepath.Join(claudeConfigDir(env), "settings.json")
	var line map[string]any
	for _, path := range claudeStatusLineFiles(env, cwd) {
		found, ok, relayInText := readStatusLine(path)
		if !ok {
			continue
		}
		if relayInText {
			return StatusLineSetup{Configured: true, File: displayHomePath(env, path)}
		}
		file, line = path, found
		break
	}
	current := ""
	if line != nil && line["type"] == "command" {
		current, _ = line["command"].(string)
	}
	if strings.Contains(current, agentStatusLineRelay) {
		return StatusLineSetup{Configured: true, File: displayHomePath(env, file), Current: current}
	}
	return StatusLineSetup{
		File:     displayHomePath(env, file),
		Current:  current,
		Language: "json",
		Snippet:  statusLineSnippet(line, current),
	}
}

// StatusLineRelayCommand wraps a status line command in the relay. Where `molten` is not on the PATH (another
// terminal app) the command runs as before, in the same shell; in MoltenTerm the relay runs it with `sh -c`.
func StatusLineRelayCommand(current string) string {
	guard := "command -v molten >/dev/null 2>&1 && exec " + agentStatusLineRelay
	if strings.TrimSpace(current) == "" {
		return guard + " || true"
	}
	return guard + " -- " + shellSingleQuote(current) + "; " + current
}

func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// statusLineSnippet writes {"statusLine": {...}} with type and command first and the user's other fields (padding,
// refreshInterval) kept.
func statusLineSnippet(line map[string]any, current string) string {
	fields := []string{
		`    "type": "command"`,
		`    "command": ` + jsonText(StatusLineRelayCommand(current)),
	}
	var keys []string
	for k := range line {
		if k != "type" && k != "command" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		fields = append(fields, "    "+jsonText(k)+": "+jsonText(line[k]))
	}
	return "{\n  \"statusLine\": {\n" + strings.Join(fields, ",\n") + "\n  }\n}"
}

// jsonText encodes without HTML escaping: the snippet's && and > stay readable.
func jsonText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}
