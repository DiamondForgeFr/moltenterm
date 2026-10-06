// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Claude Code's status line relay (FR-SHELL-027, DS-SHELL-031): Claude Code runs the user's status line command with
// its session's JSON on stdin, whose documented rate_limits object gives the plan's 5-hour and 7-day windows
// (https://code.claude.com/docs/en/statusline). `molten agent statusline -- <command>` runs that command unchanged and
// hands only those windows to the pane's companion. MoltenTerm shows the settings to paste and never writes them.

const (
	// What the snippet runs; a statusLine command that runs it is set up.
	agentStatusLineRelay = "molten agent statusline"
	// The relay reads at most this much of the status line input; the chained command still gets all of it.
	StatusLineMaxInput = 256 * 1024
)

// StatusLineWindow is one rate limit window as Claude Code gives it: percent used (0 to 100, or more behind a
// spend limit) and its reset in Unix seconds, 0 when absent.
type StatusLineWindow struct {
	UsedPercent float64 `json:"usedpercent"`
	ResetsAt    int64   `json:"resetsat,omitempty"`
}

// AgentStatusLineRequest is what the relay sends: the rate limit windows of one status line run, nothing else.
type AgentStatusLineRequest struct {
	BlockId string `json:"blockid"`
	// RateLimits: the input had a rate_limits object (a Pro or Max plan, or a gateway spend limit), readable or not.
	RateLimits bool              `json:"ratelimits,omitempty"`
	FiveHour   *StatusLineWindow `json:"fivehour,omitempty"`
	SevenDay   *StatusLineWindow `json:"sevenday,omitempty"`
	SpendLimit *StatusLineWindow `json:"spendlimit,omitempty"`
}

// HasWindows tells whether any window was read.
func (r AgentStatusLineRequest) HasWindows() bool {
	return r.FiveHour != nil || r.SevenDay != nil || r.SpendLimit != nil
}

type statusLineRawWindow struct {
	UsedPercentage *float64 `json:"used_percentage"`
	ResetsAt       *float64 `json:"resets_at"`
}

// ParseStatusLineInput keeps the rate limit windows of Claude Code's status line input. An input that is not a JSON
// object is an unknown format; a window whose fields are missing or mistyped is left out.
func ParseStatusLineInput(data []byte) (AgentStatusLineRequest, error) {
	var rtn AgentStatusLineRequest
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil || top == nil {
		return rtn, fmt.Errorf("the status line input is not a JSON object")
	}
	raw, ok := top["rate_limits"]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return rtn, nil
	}
	rtn.RateLimits = true
	var limits map[string]json.RawMessage
	if json.Unmarshal(raw, &limits) != nil {
		return rtn, nil
	}
	rtn.FiveHour = parseStatusLineWindow(limits["five_hour"])
	rtn.SevenDay = parseStatusLineWindow(limits["seven_day"])
	rtn.SpendLimit = parseStatusLineWindow(limits["spend_limit"])
	return rtn, nil
}

func parseStatusLineWindow(raw json.RawMessage) *StatusLineWindow {
	if len(raw) == 0 {
		return nil
	}
	var w statusLineRawWindow
	if json.Unmarshal(raw, &w) != nil || w.UsedPercentage == nil {
		return nil
	}
	pct := *w.UsedPercentage
	if math.IsNaN(pct) || math.IsInf(pct, 0) {
		return nil
	}
	rtn := &StatusLineWindow{UsedPercent: pct}
	if w.ResetsAt != nil && *w.ResetsAt > 0 && !math.IsInf(*w.ResetsAt, 0) {
		rtn.ResetsAt = int64(*w.ResetsAt)
	}
	return rtn
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
