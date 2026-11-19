// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Kimi Code 2.6.3 stores a session's metadata in state.json and its agents' wire protocol in
// sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl. session_index.jsonl links a hook's session id to
// that folder. The wire protocol is internal: an unknown record or a new major version makes the companion
// terminal-only rather than letting a partial parse look reliable.
const (
	kimiStateMaxBytes    = 1024 * 1024
	kimiIndexMaxBytes    = 16 * 1024 * 1024
	kimiIndexLineMax     = 1024 * 1024
	kimiSettingsTail     = 2 * 1024 * 1024
	kimiMaxWorkspaceDirs = 512
	kimiMaxSessionDirs   = 2048
)

var kimiSessionIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var kimiAgentIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

var kimiQuietTypes = map[string]bool{
	"environment.set_binding": true, "changeNotifier.snapshot": true, "permission.set_mode": true,
	"plugin.session_start": true, "tool_select.initialized": true, "llm.tools_snapshot": true,
	"llm.request": true, "usage.record": true, "token_counting.measured": true, "tools.update_store": true,
	"task.started": true, "task.terminated": true, "turn.prompt": true, "turn.ended": true,
	"prompt.completed": true, "prompt.steered": true, "token_counting.turn_recorded": true,
	"full_compaction.begin": true, "context.apply_compaction": true, "token_counting.rebased": true,
	"full_compaction.complete": true, "file_history.tracked": true, "file_history.checkpoint": true,
	"interaction.resolved": true,
}

type KimiAdapter struct {
	roots []string
}

// MakeKimiAdapter reads sessions under the given roots, or Kimi Code's own and the configured ones when roots is nil.
func MakeKimiAdapter(roots []string) *KimiAdapter {
	if roots == nil {
		home := os.Getenv("KIMI_CODE_HOME")
		if home == "" {
			if h := homeDir(); h != "" {
				home = filepath.Join(h, ".kimi-code")
			}
		}
		if home != "" {
			roots = []string{filepath.Join(home, "sessions")}
		}
		roots = withExtraRoots(molten.AgentIdKimi, roots)
	}
	return &KimiAdapter{roots: roots}
}

func (a *KimiAdapter) Id() string      { return molten.AgentIdKimi }
func (a *KimiAdapter) Roots() []string { return a.roots }

func (a *KimiAdapter) ValidLayout(rel string) bool {
	parts := strings.Split(rel, "/")
	return len(parts) == 5 && parts[0] != "" && parts[0] != "." && parts[0] != ".." &&
		kimiSessionIdRegex.MatchString(parts[1]) && parts[2] == "agents" &&
		kimiAgentIdRegex.MatchString(parts[3]) && parts[4] == "wire.jsonl"
}

type kimiState struct {
	Id            string `json:"id"`
	Version       int    `json:"version"`
	Cwd           string `json:"cwd"`
	Archived      bool   `json:"archived"`
	Title         string `json:"title"`
	TitleKind     string `json:"titleKind"`
	LastPrompt    string `json:"lastPrompt"`
	CreatedAt     any    `json:"createdAt"`
	UpdatedAt     any    `json:"updatedAt"`
	IsCustomTitle bool   `json:"isCustomTitle"`
}

func kimiSessionDir(sessionPath string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(sessionPath)))
}

func kimiStatePath(sessionPath string) string {
	return filepath.Join(kimiSessionDir(sessionPath), "state.json")
}

func readKimiState(sessionPath string) (kimiState, bool) {
	var state kimiState
	f, err := openTranscript(kimiStatePath(sessionPath))
	if err != nil {
		return state, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > kimiStateMaxBytes {
		return state, false
	}
	data, err := io.ReadAll(io.LimitReader(f, kimiStateMaxBytes+1))
	if err != nil || len(data) > kimiStateMaxBytes || json.Unmarshal(data, &state) != nil {
		return kimiState{}, false
	}
	return state, true
}

func kimiMillis(v any) int64 {
	switch value := v.(type) {
	case float64:
		if value > 0 && value <= float64(1<<53) {
			return int64(value)
		}
	case string:
		return parseTime(value)
	}
	return 0
}

func kimiRecordTime(rec map[string]any) int64 {
	if at := kimiMillis(rec["time"]); at != 0 {
		return at
	}
	return parseTime(str(rec, "timestamp"))
}

// InitSession adds the metadata that Kimi Code keeps outside wire.jsonl.
func (a *KimiAdapter) InitSession(path string, s *Session) {
	state, ok := readKimiState(path)
	if !ok {
		return
	}
	if state.Version != 0 && state.Version != 2 {
		s.MarkUnsupported()
		return
	}
	s.Id = state.Id
	s.Cwd = state.Cwd
	if state.Title != "" {
		s.SetSessionName(state.Title, state.IsCustomTitle || state.TitleKind == "custom")
	}
	if at := kimiMillis(state.CreatedAt); at > 0 {
		s.SetRecordTime(at)
	}
}

func (a *KimiAdapter) Discover(cwd string, since time.Time) []Candidate {
	folder := makeQueryFolder(cwd)
	var rtn []Candidate
	for _, root := range a.roots {
		workspaces, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for wi, workspace := range workspaces {
			if wi >= kimiMaxWorkspaceDirs || !workspace.IsDir() {
				continue
			}
			dir := filepath.Join(root, workspace.Name())
			sessions, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for si, session := range sessions {
				if si >= kimiMaxSessionDirs || !session.IsDir() || !kimiSessionIdRegex.MatchString(session.Name()) {
					continue
				}
				path := filepath.Join(dir, session.Name(), "agents", "main", "wire.jsonl")
				info, err := os.Lstat(path)
				if err != nil || !info.Mode().IsRegular() {
					continue
				}
				statePath := filepath.Join(dir, session.Name(), "state.json")
				stateInfo, _ := os.Stat(statePath)
				modified := info.ModTime()
				if stateInfo != nil && stateInfo.ModTime().After(modified) {
					modified = stateInfo.ModTime()
				}
				if modified.Before(since.Add(-startSlack)) {
					continue
				}
				state, ok := readKimiState(path)
				if !ok || state.Archived || state.Version != 2 {
					continue
				}
				head := headFacts{cwd: state.Cwd, id: state.Id, started: kimiMillis(state.CreatedAt)}
				if !head.in(folder) {
					continue
				}
				head.prompt = preview(titlePrompt(state.LastPrompt))
				head.command = commandName(state.LastPrompt)
				readHeadUntil(path, headMaxLines, func(rec map[string]any) bool {
					if str(rec, "type") != "context.append_message" {
						return false
					}
					msg := obj(rec, "message")
					if str(msg, "role") != "user" || str(obj(msg, "origin"), "kind") != "user" {
						return false
					}
					text := kimiContentText(msg["content"])
					head.command = commandName(text)
					head.prompt = preview(titlePrompt(text))
					return text != ""
				})
				rtn = append(rtn, Candidate{Path: path, Id: state.Id, Started: head.started,
					Modified: modified.UnixMilli(), Prompt: head.prompt, Command: head.command, cwd: state.Cwd})
			}
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Modified > rtn[j].Modified })
	return rtn
}

func (a *KimiAdapter) SessionMatches(path string, id string) bool {
	if !kimiSessionIdRegex.MatchString(id) || filepath.Base(path) != "wire.jsonl" || filepath.Base(filepath.Dir(path)) != "main" {
		return false
	}
	return filepath.Base(kimiSessionDir(path)) == id
}

func (a *KimiAdapter) FindSession(id string) (string, bool) {
	if !kimiSessionIdRegex.MatchString(id) {
		return "", false
	}
	for _, root := range a.roots {
		if path, ok := a.findKimiIndex(root, id); ok {
			return path, true
		}
	}
	for _, root := range a.roots {
		workspaces, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, workspace := range workspaces {
			if !workspace.IsDir() {
				continue
			}
			path := filepath.Join(root, workspace.Name(), id, "agents", "main", "wire.jsonl")
			if resolved, err := ValidateSessionPath(a, path); err == nil && a.SessionMatches(resolved, id) {
				return resolved, true
			}
		}
	}
	return "", false
}

func (a *KimiAdapter) findKimiIndex(root string, id string) (string, bool) {
	f, err := openTranscript(filepath.Join(filepath.Dir(root), "session_index.jsonl"))
	if err != nil {
		return "", false
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, kimiIndexMaxBytes))
	scanner.Buffer(make([]byte, 64*1024), kimiIndexLineMax)
	for scanner.Scan() {
		var entry struct {
			SessionDir string `json:"sessionDir"`
			SessionId  string `json:"sessionId"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.SessionId != id || entry.SessionDir == "" {
			continue
		}
		dir := entry.SessionDir
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(root, dir)
		}
		path := filepath.Join(filepath.Clean(dir), "agents", "main", "wire.jsonl")
		resolved, err := ValidateSessionPath(a, path)
		if err == nil && a.SessionMatches(resolved, id) {
			return resolved, true
		}
	}
	return "", false
}

func (a *KimiAdapter) IsSubagent(path string) bool {
	return filepath.Base(path) == "wire.jsonl" && filepath.Base(filepath.Dir(path)) != "main"
}

func (a *KimiAdapter) SessionName(sessionPath string, id string) (string, bool) {
	state, ok := readKimiState(sessionPath)
	if !ok || state.Title == "" || id != "" && state.Id != id {
		return "", false
	}
	return state.Title, true
}

func (a *KimiAdapter) WorkFolder(sessionPath string) (string, bool) {
	state, ok := readKimiState(sessionPath)
	if !ok || !filepath.IsAbs(state.Cwd) {
		return "", false
	}
	return filepath.Clean(state.Cwd), true
}

func (a *KimiAdapter) ReadSettings(path string) (molten.AgentSettings, bool) {
	facts, ok := kimiTail(path, "")
	return molten.AgentSettings{Model: facts.Model, Effort: facts.Effort}, ok && (facts.Model != "" || facts.Effort != "")
}

func (a *KimiAdapter) SubagentWritten(sessionPath string, agentId string) int64 {
	if !kimiAgentIdRegex.MatchString(agentId) || agentId == "main" || filepath.Base(filepath.Dir(sessionPath)) != "main" {
		return 0
	}
	path := filepath.Join(kimiSessionDir(sessionPath), "agents", agentId, "wire.jsonl")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.ModTime().UnixMilli()
}

func (a *KimiAdapter) SubagentIds(sessionPath string) map[string]string {
	return nil
}

func (a *KimiAdapter) ReadSubagent(sessionPath string, agentId string) (SubagentFacts, bool) {
	if !kimiAgentIdRegex.MatchString(agentId) || agentId == "main" {
		return SubagentFacts{}, false
	}
	path := filepath.Join(kimiSessionDir(sessionPath), "agents", agentId, "wire.jsonl")
	facts, ok := kimiTail(path, agentId)
	if !ok {
		return SubagentFacts{}, false
	}
	if state, stateOk := readKimiState(path); stateOk {
		facts.Worktree = state.Cwd
		facts.Branch = FolderBranch(state.Cwd)
	}
	return facts, facts.Model != "" || facts.Effort != "" || facts.Branch != "" || facts.Worktree != "" || facts.Ended
}

func kimiTail(path string, agentId string) (SubagentFacts, bool) {
	tail, err := readFileTail(path, kimiSettingsTail)
	if err != nil {
		return SubagentFacts{}, false
	}
	var facts SubagentFacts
	for end := len(tail); end > 0; {
		start := bytes.LastIndexByte(tail[:end], '\n') + 1
		line := tail[start:end]
		end = start - 1
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		switch str(rec, "type") {
		case "profile.bind":
			if agentId != "" && str(rec, "agentId") != agentId {
				continue
			}
			if facts.Model == "" {
				facts.Model = str(rec, "modelAlias")
			}
			if facts.Effort == "" {
				facts.Effort = str(rec, "thinkingEffort")
			}
		case "turn.ended":
			facts.Ended = true
		}
	}
	return facts, true
}

func (a *KimiAdapter) Parse(rec map[string]any, s *Session) bool {
	kind := str(rec, "type")
	at := kimiRecordTime(rec)
	s.SetRecordTime(at)
	switch kind {
	case "metadata":
		protocol := str(rec, "protocol_version")
		major, err := strconv.Atoi(strings.Split(protocol, ".")[0])
		if err != nil || major != 1 {
			s.MarkUnsupported()
			return false
		}
		s.Format = "Kimi Code wire " + protocol
		return true
	case "profile.bind":
		s.SetModelEffort(str(rec, "modelAlias"), str(rec, "thinkingEffort"))
		return true
	case "context.append_message":
		a.parseKimiMessage(rec, s, at)
		return true
	case "context.append_loop_event":
		return a.parseKimiLoopEvent(obj(rec, "event"), s, at)
	case "interaction.request":
		request := obj(rec, "request")
		if request == nil {
			request = rec
		}
		callId := str(rec, "toolCallId")
		if callId == "" {
			callId = str(request, "toolCallId")
		}
		tool := str(request, "toolName")
		args := argsJSON(request["display"])
		if str(request, "action") != "" {
			args = str(request, "action")
		}
		s.MarkApproval(callId, tool, args, at)
		return true
	case "permission.record_approval_result":
		s.ResolveTool(str(rec, "toolCallId"))
		return true
	case "subagent.spawned":
		s.SubagentStarted(str(rec, "parentToolCallId"), str(rec, "subagentId"), "", str(rec, "description"), str(rec, "model"), str(rec, "thinkingEffort"), at)
		return true
	case "subagent.completed":
		s.EndSubagent(str(rec, "subagentId"), "completed")
		return true
	case "subagent.failed":
		s.EndSubagent(str(rec, "subagentId"), "failed")
		return true
	case "subagent.cancelled":
		s.EndSubagent(str(rec, "subagentId"), "cancelled")
		return true
	case "subagent.started":
		return true
	}
	if kimiQuietTypes[kind] {
		return true
	}
	s.MarkUnsupported()
	return false
}

func (a *KimiAdapter) parseKimiMessage(rec map[string]any, s *Session, at int64) {
	msg := obj(rec, "message")
	if str(msg, "role") != "user" || str(obj(msg, "origin"), "kind") != "user" {
		return
	}
	text := kimiContentText(msg["content"])
	s.NoteCommand(commandName(text))
	s.StartTurn(at)
	if clean := titlePrompt(text); clean != "" && !s.PromptInTurn(clean) {
		s.AddPrompt(clean, at)
	}
}

func kimiContentText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	var parts []string
	if items, ok := content.([]any); ok {
		for _, item := range items {
			part := asObj(item)
			if str(part, "type") == "text" {
				parts = append(parts, str(part, "text"))
			}
		}
	}
	return strings.Join(parts, "\n")
}

func (a *KimiAdapter) parseKimiLoopEvent(event map[string]any, s *Session, at int64) bool {
	switch str(event, "type") {
	case "content.part":
		part := obj(event, "part")
		switch str(part, "type") {
		case "text":
			s.AddText(str(part, "text"), at)
		case "think":
		default:
			s.MarkUnsupported()
			return false
		}
		return true
	case "tool.call":
		a.parseKimiToolCall(event, s, at)
		return true
	case "tool.result":
		callId := str(event, "toolCallId")
		result := obj(event, "result")
		s.ResolveTool(callId)
		async := boolean(result, "async_launched") || boolean(result, "async") || kimiResultField(kimiContentText(result["output"]), "status") == "running"
		s.SubagentResult(callId, async, boolean(result, "isError"), str(result, "resolvedModel"))
		if agentId := kimiResultAgentId(result); agentId != "" {
			s.SetSubagentId(callId, agentId)
		}
		return true
	case "step.begin":
		return true
	case "step.end":
		switch str(event, "finishReason") {
		case "end_turn", "error":
			s.EndTurn()
		case "tool_use":
		default:
			s.MarkUnsupported()
			return false
		}
		return true
	}
	s.MarkUnsupported()
	return false
}

func (a *KimiAdapter) parseKimiToolCall(event map[string]any, s *Session, at int64) {
	callId, name := str(event, "toolCallId"), str(event, "name")
	args := obj(event, "args")
	s.AddToolCall(callId, name, argsJSON(args), at)
	s.NoteActivity(name, activityTarget(args), at)
	if name == "Bash" {
		s.NoteShellCommand(shellLine(args))
	}
	switch name {
	case "TodoList":
		var todos []Todo
		for _, item := range arr(args, "todos") {
			todo := asObj(item)
			text := str(todo, "title")
			if text == "" {
				text = str(todo, "text")
			}
			if text != "" {
				todos = append(todos, Todo{Text: text, Status: str(todo, "status")})
			}
		}
		s.SetTodos(todos)
	case "Edit", "Write":
		a.parseKimiFileEdit(callId, name, args, obj(event, "display"), s, at)
	case "Agent":
		description := str(args, "description")
		if description == "" {
			description = str(args, "prompt")
		}
		s.StartSubagent(callId, description, str(args, "subagent_type"), str(args, "model"), str(args, "effort"), boolean(args, "run_in_background"), at)
	}
}

func (a *KimiAdapter) parseKimiFileEdit(callId string, tool string, args map[string]any, display map[string]any, s *Session, at int64) {
	if s.EditSeen(callId) {
		return
	}
	path := str(args, "path")
	if path == "" {
		path = str(display, "path")
	}
	if path != "" && !filepath.IsAbs(path) && s.Cwd != "" {
		path = filepath.Join(s.Cwd, path)
	}
	kind := FileUpdated
	if tool == "Write" || str(display, "operation") == "write" {
		kind = FileAdded
	}
	var diff string
	if tool == "Write" {
		content := str(args, "content")
		if content == "" {
			content = str(display, "after")
		}
		diff = contentDiff(content)
	} else {
		before, after := str(args, "old_string"), str(args, "new_string")
		if before == "" && after == "" {
			before, after = str(display, "before"), str(display, "after")
		}
		diff = kimiEditDiff(before, after)
	}
	s.AddFileEdit(path, kind, diff, at)
}

func kimiEditDiff(before string, after string) string {
	if before == "" && after == "" {
		return ""
	}
	oldLines := strings.Split(strings.TrimSuffix(cutString(before, MaxDiffBytes), "\n"), "\n")
	newLines := strings.Split(strings.TrimSuffix(cutString(after, MaxDiffBytes), "\n"), "\n")
	var b strings.Builder
	b.WriteString("@@ -1," + strconv.Itoa(len(oldLines)) + " +1," + strconv.Itoa(len(newLines)) + " @@\n")
	for _, line := range oldLines {
		b.WriteString("-" + line + "\n")
	}
	for _, line := range newLines {
		b.WriteString("+" + line + "\n")
		if b.Len() > MaxDiffBytes {
			break
		}
	}
	return b.String()
}

func kimiResultAgentId(result map[string]any) string {
	for _, key := range []string{"agentId", "agent_id"} {
		if id := str(result, key); id != "" {
			return id
		}
	}
	output := kimiContentText(result["output"])
	var decoded map[string]any
	if output != "" && json.Unmarshal([]byte(output), &decoded) == nil {
		for _, key := range []string{"agentId", "agent_id"} {
			if id := str(decoded, key); id != "" {
				return id
			}
		}
	}
	id := kimiResultField(output, "agent_id")
	if !kimiAgentIdRegex.MatchString(id) {
		return ""
	}
	return id
}

func kimiResultField(output string, key string) string {
	for _, line := range strings.Split(output, "\n") {
		if value, ok := strings.CutPrefix(line, key+": "); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
