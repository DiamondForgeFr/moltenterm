// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Claude Code keeps one JSONL transcript per session in <config>/projects/<slugified cwd>/<session id>.jsonl, the
// config folder being $CLAUDE_CONFIG_DIR or ~/.claude. Each line is one record: user prompts and tool results
// ("user"), one content block of the model's message per line ("assistant": text, thinking, tool_use), attachments
// (task reminders among them) and bookkeeping records this adapter ignores.

const claudeSlugMax = 200

var claudeSlugRegex = regexp.MustCompile(`[^A-Za-z0-9]`)

// Records Claude Code writes that carry nothing for the companion; a record with a session id is known too.
var claudeQuietTypes = map[string]bool{
	"system": true, "summary": true, "file-history-snapshot": true, "file-history-delta": true,
	"permission-mode": true, "mode": true, "last-prompt": true, "ai-title": true, "custom-title": true,
	"pr-link": true, "frame-link": true, "queue-operation": true, "tag": true,
}

type ClaudeAdapter struct {
	roots []string
}

// MakeClaudeAdapter reads sessions under the given roots, or Claude Code's own and the
// configured ones (agent:sessionroots) when roots is nil.
func MakeClaudeAdapter(roots []string) *ClaudeAdapter {
	if roots == nil {
		config := os.Getenv("CLAUDE_CONFIG_DIR")
		if config == "" {
			if home := homeDir(); home != "" {
				config = filepath.Join(home, ".claude")
			}
		}
		if config != "" {
			roots = []string{filepath.Join(config, "projects")}
		}
		roots = withExtraRoots(molten.AgentIdClaude, roots)
	}
	return &ClaudeAdapter{roots: roots}
}

func (a *ClaudeAdapter) Id() string {
	return molten.AgentIdClaude
}

func (a *ClaudeAdapter) Roots() []string {
	return a.roots
}

// ClaudeSlug is the folder name Claude Code gives a working directory: every character but letters and digits
// becomes a dash.
func ClaudeSlug(cwd string) string {
	return claudeSlugRegex.ReplaceAllString(cwd, "-")
}

// <slug>/<session>.jsonl, nothing deeper (sub-agents' transcripts live in <slug>/<session>/subagents/).
func (a *ClaudeAdapter) ValidLayout(rel string) bool {
	parts := strings.Split(rel, "/")
	if len(parts) != 2 {
		return false
	}
	return parts[0] != "" && !strings.HasPrefix(parts[1], ".") && strings.HasSuffix(parts[1], ".jsonl")
}

func (a *ClaudeAdapter) projectDirs(root string, cwd string) []string {
	slug := ClaudeSlug(filepath.Clean(cwd))
	if len(slug) <= claudeSlugMax {
		return []string{filepath.Join(root, slug)}
	}
	// A long path's folder is cut and suffixed with a hash: match the cut part.
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var rtn []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), slug[:claudeSlugMax]) {
			rtn = append(rtn, filepath.Join(root, e.Name()))
		}
	}
	return rtn
}

func (a *ClaudeAdapter) Discover(cwd string, since time.Time) []Candidate {
	// The shell's folder may be a symlink's path (/tmp on macOS) while Claude Code names the folder after the real one.
	cwds := []string{filepath.Clean(cwd)}
	if real, err := filepath.EvalSymlinks(cwd); err == nil && real != cwds[0] {
		cwds = append(cwds, real)
	}
	var rtn []Candidate
	seen := map[string]bool{}
	for _, root := range a.roots {
		for _, c := range cwds {
			for _, dir := range a.projectDirs(root, c) {
				if seen[dir] {
					continue
				}
				seen[dir] = true
				rtn = append(rtn, a.discoverDir(dir, cwd, since)...)
			}
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Modified > rtn[j].Modified })
	return rtn
}

func (a *ClaudeAdapter) discoverDir(dir string, cwd string, since time.Time) []Candidate {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []Candidate
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !strings.HasSuffix(name, ".jsonl") || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Before(since.Add(-startSlack)) {
			continue
		}
		path := filepath.Join(dir, name)
		c := Candidate{Path: path, Id: strings.TrimSuffix(name, ".jsonl"), Modified: info.ModTime().UnixMilli()}
		for _, rec := range readHead(path, headMaxLines) {
			if boolean(rec, "isSidechain") {
				continue
			}
			if c.cwd == "" {
				c.cwd = str(rec, "cwd")
			}
			if c.Started == 0 {
				c.Started = parseTime(str(rec, "timestamp"))
			}
			if c.Prompt == "" && str(rec, "type") == "user" && !boolean(rec, "isMeta") && !boolean(rec, "isCompactSummary") {
				text := claudePromptText(obj(rec, "message"))
				if c.Command == "" {
					c.Command = commandName(text)
				}
				c.Prompt = preview(titlePrompt(text))
			}
			if c.cwd != "" && c.Started != 0 && c.Prompt != "" {
				break
			}
		}
		if c.cwd != "" && !samePath(c.cwd, cwd) {
			continue
		}
		rtn = append(rtn, c)
	}
	return rtn
}

// claudePromptText is the text of a user message: a plain string, or its text blocks (tool results are not prompts).
func claudePromptText(msg map[string]any) string {
	if msg == nil {
		return ""
	}
	if s, ok := msg["content"].(string); ok {
		return s
	}
	var parts []string
	for _, item := range arr(msg, "content") {
		block := asObj(item)
		if str(block, "type") == "text" {
			parts = append(parts, str(block, "text"))
		}
	}
	return strings.Join(parts, "\n")
}

func (a *ClaudeAdapter) Parse(rec map[string]any, s *Session) bool {
	kind := str(rec, "type")
	if v := str(rec, "version"); v != "" {
		s.Format = "Claude Code " + v
	}
	if boolean(rec, "isSidechain") {
		return true
	}
	at := parseTime(str(rec, "timestamp"))
	s.SetRecordTime(at)
	if s.Id == "" {
		s.Id = str(rec, "sessionId")
	}
	switch kind {
	case "user":
		a.parseUser(rec, s, at)
		return true
	case "assistant":
		a.parseAssistant(rec, s, at)
		return true
	case "attachment":
		a.parseAttachment(obj(rec, "attachment"), s)
		return true
	}
	if claudeQuietTypes[kind] {
		return true
	}
	return kind != "" && str(rec, "sessionId") != ""
}

func (a *ClaudeAdapter) parseUser(rec map[string]any, s *Session, at int64) {
	msg := obj(rec, "message")
	isMeta := boolean(rec, "isMeta")
	if text, ok := msg["content"].(string); ok {
		if !isMeta && !boolean(rec, "isCompactSummary") && cleanTitleText(text) != "" && !isCommandRecord(text) {
			s.StartTurn(at)
			s.AddPrompt(titlePrompt(text), at)
		}
		return
	}
	prompt := false
	callId := ""
	var texts []string
	for _, item := range arr(msg, "content") {
		block := asObj(item)
		switch str(block, "type") {
		case "tool_result":
			id := str(block, "tool_use_id")
			if callId == "" {
				callId = id
			}
			s.ResolveTool(id)
		case "text":
			text := str(block, "text")
			if !isCommandRecord(text) && cleanTitleText(text) != "" {
				prompt = true
				texts = append(texts, text)
			}
		case "image":
			prompt = true
		}
	}
	if prompt && !isMeta && callId == "" {
		s.StartTurn(at)
		if !boolean(rec, "isCompactSummary") {
			s.AddPrompt(titlePrompt(strings.Join(texts, "\n")), at)
		}
	}
	if result := obj(rec, "toolUseResult"); result != nil {
		a.parseEdits(result, callId, s, at)
	}
}

// parseEdits reads the file changes of a tool result: Edit and Write give a structured patch (Write of a new file,
// its content); a shell command that edited files gives bashEditDiff.
func (a *ClaudeAdapter) parseEdits(result map[string]any, callId string, s *Session, at int64) {
	if path := str(result, "filePath"); path != "" {
		if _, hasPatch := result["structuredPatch"]; hasPatch {
			if s.EditSeen(callId) {
				return
			}
			kind := FileUpdated
			diff := hunksDiff(arr(result, "structuredPatch"))
			if str(result, "type") == "create" {
				kind = FileAdded
				if diff == "" {
					diff = contentDiff(str(result, "content"))
				}
			}
			s.AddFileEdit(path, kind, diff, at)
		}
		return
	}
	bash := obj(result, "bashEditDiff")
	if bash == nil || s.EditSeen(callId) {
		return
	}
	for _, f := range arr(bash, "files") {
		file := asObj(f)
		path := str(file, "filePath")
		if path == "" {
			continue
		}
		kind := FileUpdated
		if boolean(file, "created") {
			kind = FileAdded
		} else if boolean(file, "deleted") {
			kind = FileDeleted
		}
		s.AddFileEdit(path, kind, hunksDiff(arr(file, "hunks")), at)
	}
}

func (a *ClaudeAdapter) parseAssistant(rec map[string]any, s *Session, at int64) {
	msg := obj(rec, "message")
	if text, ok := msg["content"].(string); ok {
		s.AddText(text, at)
		return
	}
	for _, item := range arr(msg, "content") {
		block := asObj(item)
		switch str(block, "type") {
		case "text":
			s.AddText(str(block, "text"), at)
		case "tool_use":
			name := str(block, "name")
			input := obj(block, "input")
			s.AddToolCall(str(block, "id"), name, argsJSON(input), at)
			a.parseTasks(name, input, s)
		}
	}
}

// parseTasks follows the task list: TodoWrite replaces it; TaskCreate and TaskUpdate change one task.
func (a *ClaudeAdapter) parseTasks(tool string, input map[string]any, s *Session) {
	switch tool {
	case "TodoWrite":
		var todos []Todo
		for _, item := range arr(input, "todos") {
			todo := asObj(item)
			text := str(todo, "content")
			if text == "" {
				text = str(todo, "subject")
			}
			if text != "" {
				todos = append(todos, Todo{Text: text, Status: str(todo, "status")})
			}
		}
		s.SetTodos(todos)
	case "TaskCreate":
		text := str(input, "subject")
		if text == "" {
			text = str(input, "description")
		}
		if text != "" {
			s.UpsertTodo(len(s.todos), text, str(input, "status"))
		}
	case "TaskUpdate":
		index, ok := taskIndex(input["taskId"])
		if ok {
			s.UpsertTodo(index, str(input, "subject"), str(input, "status"))
		}
	}
}

// Task ids count from 1.
func taskIndex(v any) (int, bool) {
	switch id := v.(type) {
	case float64:
		return int(id) - 1, id >= 1
	case string:
		n, err := strconv.Atoi(strings.TrimPrefix(id, "#"))
		return n - 1, err == nil && n >= 1
	}
	return 0, false
}

// Task reminders repeat the task list as Claude Code sees it.
func (a *ClaudeAdapter) parseAttachment(att map[string]any, s *Session) {
	switch str(att, "type") {
	case "task_reminder", "todo_reminder":
	default:
		return
	}
	items := arr(att, "content")
	if len(items) == 0 {
		return
	}
	var todos []Todo
	for _, item := range items {
		todo := asObj(item)
		text := str(todo, "subject")
		if text == "" {
			text = str(todo, "content")
		}
		if text != "" {
			todos = append(todos, Todo{Text: text, Status: str(todo, "status")})
		}
	}
	if len(todos) > 0 {
		s.SetTodos(todos)
	}
}
