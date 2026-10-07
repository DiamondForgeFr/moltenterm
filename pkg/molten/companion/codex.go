// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Codex keeps one JSONL "rollout" per session in <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, the home being
// $CODEX_HOME or ~/.codex. Each line is {timestamp, type, payload}: session_meta (folder, version, source),
// response_item (the model's messages and tool calls, as sent to the API), event_msg (what the interface shows:
// prompts, turn starts and ends, approval requests, file changes, and the plan's rate limits of each token_count)
// and bookkeeping this adapter ignores. The oldest rollouts wrote the response items bare, without the wrapper.

const codexMaxDays = 7

var codexResponseTypes = map[string]bool{
	"message": true, "function_call": true, "function_call_output": true, "custom_tool_call": true,
	"custom_tool_call_output": true, "local_shell_call": true, "reasoning": true,
}

var codexQuietTypes = map[string]bool{
	"turn_context": true, "compacted": true, "world_state": true, "token_usage_record": true,
	"inter_agent_communication_metadata": true,
}

type CodexAdapter struct {
	roots []string
}

// MakeCodexAdapter reads sessions under the given roots, or Codex's own and the
// configured ones (agent:sessionroots) when roots is nil.
func MakeCodexAdapter(roots []string) *CodexAdapter {
	if roots == nil {
		home := os.Getenv("CODEX_HOME")
		if home == "" {
			if h := homeDir(); h != "" {
				home = filepath.Join(h, ".codex")
			}
		}
		if home != "" {
			roots = []string{filepath.Join(home, "sessions")}
		}
		roots = withExtraRoots(molten.AgentIdCodex, roots)
	}
	return &CodexAdapter{roots: roots}
}

func (a *CodexAdapter) Id() string {
	return molten.AgentIdCodex
}

func (a *CodexAdapter) Roots() []string {
	return a.roots
}

func allDigits(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// YYYY/MM/DD/rollout-*.jsonl
func (a *CodexAdapter) ValidLayout(rel string) bool {
	parts := strings.Split(rel, "/")
	if len(parts) != 4 {
		return false
	}
	return allDigits(parts[0], 4) && allDigits(parts[1], 2) && allDigits(parts[2], 2) &&
		strings.HasPrefix(parts[3], "rollout-") && strings.HasSuffix(parts[3], ".jsonl")
}

func (a *CodexAdapter) Discover(cwd string, since time.Time) []Candidate {
	var rtn []Candidate
	now := time.Now()
	first := since.Add(-24 * time.Hour)
	if now.Sub(first) > codexMaxDays*24*time.Hour {
		first = now.Add(-codexMaxDays * 24 * time.Hour)
	}
	seen := map[string]bool{}
	for _, root := range a.roots {
		// Folders are named by date (local or UTC depending on the version): one day of margin on both sides.
		for day := first; !day.After(now.Add(24 * time.Hour)); day = day.Add(24 * time.Hour) {
			dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
			if seen[dir] {
				continue
			}
			seen[dir] = true
			rtn = append(rtn, a.discoverDir(dir, cwd, since)...)
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Modified > rtn[j].Modified })
	return rtn
}

func (a *CodexAdapter) discoverDir(dir string, cwd string, since time.Time) []Candidate {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []Candidate
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Before(since.Add(-startSlack)) {
			continue
		}
		path := filepath.Join(dir, name)
		c := Candidate{Path: path, Modified: info.ModTime().UnixMilli()}
		subagent := false
		for _, rec := range readHead(path, 50) {
			payload := obj(rec, "payload")
			switch str(rec, "type") {
			case "session_meta":
				c.cwd = str(payload, "cwd")
				c.Id = str(payload, "id")
				c.Started = parseTime(str(payload, "timestamp"))
				subagent = codexSubagent(payload)
			case "event_msg":
				if c.Prompt == "" && str(payload, "type") == "user_message" {
					c.Prompt = preview(cleanTitleText(str(payload, "message")))
				}
			}
			if c.cwd != "" && c.Prompt != "" {
				break
			}
		}
		// Without its folder a rollout cannot be told apart: only a hook's report links it.
		if subagent || !samePath(c.cwd, cwd) {
			continue
		}
		rtn = append(rtn, c)
	}
	return rtn
}

// A Codex thread id is a UUID; anything else is never looked up.
var codexThreadIdRegex = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)

// How many dated folders, newest first, a lookup by id reads after the last days: a resumed session older than
// about a year is linked by folder discovery or the picker instead.
const codexFindMaxDays = 400

// SessionMatches tells whether a rollout path is the one of a thread id.
func (a *CodexAdapter) SessionMatches(path string, id string) bool {
	name := filepath.Base(path)
	return codexThreadIdRegex.MatchString(id) && strings.HasPrefix(name, "rollout-") && strings.HasSuffix(strings.ToLower(name), "-"+strings.ToLower(id)+".jsonl")
}

// FindSession finds the rollout of a thread id (rollout-<time>-<id>.jsonl): in the folders of the last days first,
// where a session that just ended a turn almost always is, then in the older dated folders, newest first, for a
// resumed session.
func (a *CodexAdapter) FindSession(id string) (string, bool) {
	if !codexThreadIdRegex.MatchString(id) {
		return "", false
	}
	suffix := "-" + strings.ToLower(id) + ".jsonl"
	now := time.Now()
	seen := map[string]bool{}
	for _, root := range a.roots {
		for day := now.Add(24 * time.Hour); !day.Before(now.Add(-codexMaxDays * 24 * time.Hour)); day = day.Add(-24 * time.Hour) {
			dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
			seen[dir] = true
			if path, ok := codexRolloutIn(dir, suffix); ok {
				return path, true
			}
		}
	}
	for _, root := range a.roots {
		read := 0
		for _, dir := range codexDayDirs(root) {
			if seen[dir] {
				continue
			}
			if read++; read > codexFindMaxDays {
				break
			}
			if path, ok := codexRolloutIn(dir, suffix); ok {
				return path, true
			}
		}
	}
	return "", false
}

func (a *CodexAdapter) IsSubagent(path string) bool {
	for _, rec := range readHead(path, 50) {
		if str(rec, "type") == "session_meta" {
			return codexSubagent(obj(rec, "payload"))
		}
	}
	return false
}

// codexDayDirs lists a root's YYYY/MM/DD folders, newest first.
func codexDayDirs(root string) []string {
	var rtn []string
	for _, year := range codexDigitDirs(root, 4) {
		for _, month := range codexDigitDirs(year, 2) {
			rtn = append(rtn, codexDigitDirs(month, 2)...)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(rtn)))
	return rtn
}

func codexDigitDirs(dir string, n int) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []string
	for _, e := range entries {
		if e.IsDir() && allDigits(e.Name(), n) {
			rtn = append(rtn, filepath.Join(dir, e.Name()))
		}
	}
	return rtn
}

func codexRolloutIn(dir string, suffix string) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		name := e.Name()
		if e.Type().IsRegular() && strings.HasPrefix(name, "rollout-") && strings.HasSuffix(strings.ToLower(name), suffix) {
			return filepath.Join(dir, name), true
		}
	}
	return "", false
}

// Sub-agents and reviewers write their own rollouts next to the session that started them.
func codexSubagent(meta map[string]any) bool {
	if src := obj(meta, "source"); src != nil && src["subagent"] != nil {
		return true
	}
	switch str(meta, "thread_source") {
	case "subagent", "guardian_review":
		return true
	}
	return str(meta, "parent_thread_id") != ""
}

func (a *CodexAdapter) Parse(rec map[string]any, s *Session) bool {
	kind := str(rec, "type")
	payload := obj(rec, "payload")
	at := parseTime(str(rec, "timestamp"))
	if payload == nil && codexResponseTypes[kind] {
		a.parseItem(rec, s, at)
		return true
	}
	switch kind {
	case "session_meta":
		if v := str(payload, "cli_version"); v != "" {
			s.Format = "Codex " + v
		}
		if cwd := str(payload, "cwd"); cwd != "" {
			s.Cwd = cwd
		}
		return true
	case "turn_context":
		if cwd := str(payload, "cwd"); cwd != "" {
			s.Cwd = cwd
		}
		return true
	case "response_item":
		a.parseItem(payload, s, at)
		return true
	case "event_msg":
		a.parseEvent(payload, s, at)
		return true
	}
	if codexQuietTypes[kind] {
		return true
	}
	// The oldest rollouts start with a bare header.
	if kind == "" && str(rec, "id") != "" && rec["instructions"] != nil {
		return true
	}
	return kind != "" && payload != nil
}

func (a *CodexAdapter) parseItem(item map[string]any, s *Session, at int64) {
	switch str(item, "type") {
	case "message":
		if str(item, "role") != "assistant" {
			return
		}
		for _, c := range arr(item, "content") {
			block := asObj(c)
			switch str(block, "type") {
			case "output_text", "text":
				s.AddText(str(block, "text"), at)
			}
		}
	case "function_call":
		name := str(item, "name")
		args := str(item, "arguments")
		s.AddToolCall(codexCallId(item), name, args, at)
		if name == "update_plan" {
			var input map[string]any
			if json.Unmarshal([]byte(args), &input) == nil {
				s.SetTodos(codexPlan(arr(input, "plan")))
			}
		}
	case "custom_tool_call":
		s.AddToolCall(codexCallId(item), str(item, "name"), compactJSON(item["input"]), at)
	case "local_shell_call":
		s.AddToolCall(codexCallId(item), "shell", argsJSON(item["action"]), at)
	case "function_call_output", "custom_tool_call_output":
		s.ResolveTool(codexCallId(item))
	}
}

func codexCallId(item map[string]any) string {
	if id := str(item, "call_id"); id != "" {
		return id
	}
	return str(item, "id")
}

func codexPlan(items []any) []Todo {
	var todos []Todo
	for _, it := range items {
		step := asObj(it)
		text := str(step, "step")
		if text == "" {
			text = str(step, "text")
		}
		status := str(step, "status")
		if boolean(step, "completed") {
			status = TodoCompleted
		}
		if text != "" {
			todos = append(todos, Todo{Text: text, Status: status})
		}
	}
	return todos
}

func (a *CodexAdapter) parseEvent(ev map[string]any, s *Session, at int64) {
	switch str(ev, "type") {
	case "user_message", "task_started", "turn_started":
		s.StartTurn(at)
	case "task_complete", "turn_complete", "turn_aborted":
		s.EndTurn()
	case "exec_approval_request":
		s.MarkApproval(str(ev, "call_id"), "exec", argsJSON(ev["command"]), at)
	case "apply_patch_approval_request":
		s.MarkApproval(str(ev, "call_id"), "apply_patch", strings.Join(codexChangePaths(obj(ev, "changes")), "\n"), at)
	case "exec_command_begin", "exec_command_end", "patch_apply_end":
		s.ResolveTool(str(ev, "call_id"))
	case "patch_apply_begin":
		callId := str(ev, "call_id")
		s.ResolveTool(callId)
		if !s.EditSeen(callId) {
			a.parseChanges(obj(ev, "changes"), s, at)
		}
	case "plan_update":
		s.SetTodos(codexPlan(arr(ev, "plan")))
	case "token_count":
		s.AddCodexRateLimits(ev["rate_limits"], at)
	case "item_completed":
		item := obj(ev, "item")
		switch str(item, "type") {
		case "FileChange":
			switch str(item, "status") {
			case "declined", "failed":
				return
			}
			if !s.EditSeen(str(item, "id")) {
				a.parseChanges(obj(item, "changes"), s, at)
			}
		case "TodoList", "Plan":
			todos := codexPlan(arr(item, "items"))
			if todos == nil {
				todos = codexPlan(arr(item, "plan"))
			}
			s.SetTodos(todos)
		}
	}
}

func codexChangePaths(changes map[string]any) []string {
	paths := make([]string, 0, len(changes))
	for path := range changes {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// parseChanges reads a patch's changes, {path: change}, in either shape Codex wrote: {type, content | unified_diff,
// move_path} or {add: {content}} / {update: {unified_diff, move_path}} / {delete: {}}.
func (a *CodexAdapter) parseChanges(changes map[string]any, s *Session, at int64) {
	for _, path := range codexChangePaths(changes) {
		change := asObj(changes[path])
		kind := str(change, "type")
		body := change
		for _, k := range []string{FileAdded, FileUpdated, FileDeleted} {
			if inner := obj(change, k); inner != nil {
				kind, body = k, inner
			}
		}
		target := path
		if move := str(body, "move_path"); move != "" {
			target = move
		}
		target = a.absolute(target, s)
		switch kind {
		case FileAdded:
			s.AddFileEdit(target, FileAdded, contentDiff(str(body, "content")), at)
		case FileDeleted:
			s.AddFileEdit(target, FileDeleted, "", at)
		case FileUpdated:
			s.AddFileEdit(target, FileUpdated, str(body, "unified_diff"), at)
		}
	}
}

func (a *CodexAdapter) absolute(path string, s *Session) string {
	if filepath.IsAbs(path) || s.Cwd == "" {
		return path
	}
	return filepath.Join(s.Cwd, path)
}
