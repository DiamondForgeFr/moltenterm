// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"encoding/json"
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

// A sub-agent's facts (#601) are read from the end of its transcript; its meta files are small and few.
const (
	claudeSubagentTailBytes = 256 * 1024
	claudeMaxSubagentMetas  = 200
	claudeMaxMetaBytes      = 64 * 1024
)

var claudeSlugRegex = regexp.MustCompile(`[^A-Za-z0-9]`)

// Records Claude Code writes that carry nothing for the companion; a record with a session id is known too.
var claudeQuietTypes = map[string]bool{
	"system": true, "summary": true, "file-history-snapshot": true, "file-history-delta": true,
	"permission-mode": true, "mode": true, "last-prompt": true, "ai-title": true, "custom-title": true,
	"pr-link": true, "frame-link": true, "queue-operation": true, "tag": true,
}

// An agent id names a file: letters, digits, dashes and underscores only.
var claudeAgentIdRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

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

// SubagentWritten reads when a sub-agent last wrote <slug>/<session>/subagents/agent-<id>.jsonl.
func (a *ClaudeAdapter) SubagentWritten(sessionPath string, agentId string) int64 {
	if !claudeAgentIdRegex.MatchString(agentId) || !strings.HasSuffix(sessionPath, ".jsonl") {
		return 0
	}
	dir := strings.TrimSuffix(sessionPath, ".jsonl")
	info, err := os.Stat(filepath.Join(dir, "subagents", "agent-"+agentId+".jsonl"))
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.ModTime().UnixMilli()
}

// SubagentIds reads the sub-agents' agent-<id>.meta.json files next to the session: each names the call that started
// its agent (toolUseId), foreground agents included.
func (a *ClaudeAdapter) SubagentIds(sessionPath string) map[string]string {
	if !strings.HasSuffix(sessionPath, ".jsonl") {
		return nil
	}
	dir := filepath.Join(strings.TrimSuffix(sessionPath, ".jsonl"), "subagents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	rtn := map[string]string{}
	read := 0
	for _, e := range entries {
		name := e.Name()
		agentId, ok := strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json")
		if !ok || !strings.HasPrefix(name, "agent-") || !claudeAgentIdRegex.MatchString(agentId) || !e.Type().IsRegular() {
			continue
		}
		if read >= claudeMaxSubagentMetas {
			break
		}
		read++
		meta, ok := readClaudeSubagentMeta(filepath.Join(dir, name))
		if !ok || meta.ToolUseId == "" {
			continue
		}
		rtn[meta.ToolUseId] = agentId
	}
	return rtn
}

// ReadSubagent reads the end of a sub-agent's transcript for its latest model (the model's own answers) and effort,
// and its branch from its own folder on disk (#967): its worktree's (agent-<id>.meta.json), else its records' cwd.
// The branch its records name is never taken: Claude Code shares it across the worktrees of one process.
func (a *ClaudeAdapter) ReadSubagent(sessionPath string, agentId string) (SubagentFacts, bool) {
	if !claudeAgentIdRegex.MatchString(agentId) || !strings.HasSuffix(sessionPath, ".jsonl") {
		return SubagentFacts{}, false
	}
	subs := filepath.Join(strings.TrimSuffix(sessionPath, ".jsonl"), "subagents")
	path := filepath.Join(subs, "agent-"+agentId+".jsonl")
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return SubagentFacts{}, false
	}
	tail, err := readFileTail(path, claudeSubagentTailBytes)
	if err != nil {
		return SubagentFacts{}, false
	}
	meta, _ := readClaudeSubagentMeta(filepath.Join(subs, "agent-"+agentId+".meta.json"))
	dir := meta.WorktreePath
	tf := claudeTailFacts(tail, dir == "")
	if dir == "" {
		dir = tf.cwd
	}
	facts := SubagentFacts{Model: tf.model, Effort: tf.effort, Worktree: dir}
	facts.Branch = FolderBranch(dir)
	return facts, facts.Model != "" || facts.Effort != "" || facts.Branch != ""
}

type claudeTailRec struct {
	Cwd     string `json:"cwd"`
	Effort  string `json:"effort"`
	Message struct {
		Model string `json:"model"`
	} `json:"message"`
}

func claudeTailRecord(line []byte) (claudeTailRec, bool) {
	var rec claudeTailRec
	if len(line) == 0 || json.Unmarshal(line, &rec) != nil {
		return claudeTailRec{}, false
	}
	return rec, true
}

func splitLines(tail []byte) [][]byte {
	return bytes.Split(tail, []byte("\n"))
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
	if cwd := str(rec, "cwd"); cwd != "" {
		s.Cwd = cwd
	}
	// After the record: a prompt that comes with a new branch gives it to its own topic, not to the one before.
	defer s.SetBranch(str(rec, "gitBranch"))
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
	case "queue-operation":
		// A background agent's end is queued for the main agent: it may reach it as a queued command (an
		// attachment) rather than as a message of the user, so the queue tells it first.
		if str(rec, "operation") == "enqueue" {
			a.parseNotifications(str(rec, "content"), s)
		}
		return true
	case "ai-title":
		s.SetSessionName(str(rec, "aiTitle"), false)
		return true
	case "custom-title":
		name := str(rec, "customTitle")
		if name == "" {
			name = str(rec, "title")
		}
		s.SetSessionName(name, true)
		return true
	case "pr-link":
		if n, ok := num(rec, "prNumber"); ok {
			s.AddPRLink(int(n), str(rec, "prUrl"))
		}
		return true
	case "frame-link":
		// A page shown to the user (FR-MAT-001 signal 1); the records without a path only count them.
		if path, url := str(rec, "path"), str(rec, "frameUrl"); path != "" && url != "" {
			s.NotePublication(Publication{Path: path, Url: url, Title: str(rec, "title")}, at)
		}
		return true
	case "system":
		if sub := str(rec, "subtype"); sub == "turn_duration" || sub == "stop_hook_summary" {
			s.NoteTurnEnd()
		}
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
		if a.parseNotifications(text, s) {
			s.StartTurn(at)
			return
		}
		s.NoteCommand(commandName(text))
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
			result := obj(rec, "toolUseResult")
			s.SubagentResult(id, str(result, "status") == "async_launched", boolean(block, "is_error"), str(result, "resolvedModel"))
			s.SetSubagentId(id, str(result, "agentId"))
		case "text":
			text := str(block, "text")
			if a.parseNotifications(text, s) {
				continue
			}
			s.NoteCommand(commandName(text))
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
		a.parsePublication(result, callId, s, at)
	}
}

// parsePublication reads the result of Claude Code's Artifact tool (FR-MAT-001 signal 1): {url, path, artifact_id,
// title, updated, files_written: [{path}]}; the call's own files map adds the linked files it sent.
func (a *ClaudeAdapter) parsePublication(result map[string]any, callId string, s *Session, at int64) {
	sources := s.takePublishInput(callId)
	url, path := str(result, "url"), str(result, "path")
	if url == "" || path == "" || str(result, "artifact_id") == "" {
		return
	}
	var input []any
	for published := range sources {
		input = append(input, published)
	}
	files := signalFiles(arr(result, "files_written"), arr(result, "new_files"), arr(result, "own_files"), input)
	sort.Strings(files)
	s.NotePublication(Publication{Path: path, Url: url, Title: str(result, "title"), ArtifactId: str(result, "artifact_id"), Updated: boolean(result, "updated"), Files: files, Sources: sources}, at)
}

// claudePublishFiles reads the linked files an Artifact call sends: files maps each published path (relative to the
// page) to its source, a path or {from}.
func claudePublishFiles(input map[string]any) map[string]string {
	rtn := map[string]string{}
	switch files := input["files"].(type) {
	case map[string]any:
		for published, source := range files {
			switch src := source.(type) {
			case string:
				rtn[published] = src
			case map[string]any:
				if from := str(src, "from"); from != "" {
					rtn[published] = from
				}
			}
			if len(rtn) >= MaxSignalFiles {
				break
			}
		}
	case []any:
		for _, f := range files {
			if p := str(asObj(f), "path"); p != "" {
				rtn[p] = ""
			}
		}
	}
	return rtn
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
	s.SetModelEffort(str(msg, "model"), str(rec, "effort"))
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
			s.NoteActivity(name, activityTarget(input), at)
			if name == "Bash" {
				s.NoteShellCommand(shellLine(input))
			}
			if name == "Artifact" {
				s.notePublishInput(str(block, "id"), claudePublishFiles(input))
			}
			a.parseTasks(name, input, s)
			a.parseSubagent(str(block, "id"), name, input, s, at)
		}
	}
}

// parseSubagent follows the agents the main one starts: its Agent call (Task in older versions) names them; a
// background one's call returns at once and its end comes as a notification.
func (a *ClaudeAdapter) parseSubagent(id string, tool string, input map[string]any, s *Session, at int64) {
	if tool != "Agent" && tool != "Task" {
		return
	}
	background := boolean(input, "run_in_background") || str(input, "run_in_background") == "true"
	s.StartSubagent(id, str(input, "description"), str(input, "subagent_type"), str(input, "model"), str(input, "effort"), background, at)
}

// parseNotifications ends the background agents a record notifies about; true when the text holds nothing else (it
// is the agent's own message, not a prompt of the user).
func (a *ClaudeAdapter) parseNotifications(text string, s *Session) bool {
	ends, only := taskNotifications(text)
	for _, end := range ends {
		s.EndSubagent(end[0], end[1])
	}
	return only
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
	case "queued_command":
		if prompt, ok := att["prompt"].(string); ok {
			a.parseNotifications(prompt, s)
		}
		return
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
