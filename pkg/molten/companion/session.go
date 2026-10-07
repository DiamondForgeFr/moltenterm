// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package companion is the agent companion (FR-SHELL-018, DS-SHELL-019): wavesrv follows the session transcript of
// the coding agent running in a terminal block, read in place and never written, and normalises it into the events
// the companion view shows: the answers, the files changed with their diffs, the task list, the pending tool calls
// and permission request. One adapter per agent reads its format (claude.go, codex.go): adapters are the future mod
// surface for other agents.
//
// Privacy (NFR-SHELL-006): transcripts are opened read-only, nothing of them is written, copied, cached on disk,
// logged or sent over the network. What the companion keeps lives in wavesrv's memory, bounded, and reaches the
// window through the local event bus only.
package companion

import (
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

const (
	MaxAnswers     = 100
	MaxAnswerBytes = 256 * 1024
	MaxFiles       = 300
	MaxDiffBytes   = 128 * 1024
	// All the diffs of a session together; the oldest files' diffs go first.
	MaxSessionDiffBytes = 8 * 1024 * 1024
	MaxTodos            = 100
	MaxTodoText         = 500
	MaxPending          = 20
	MaxArgsBytes        = 4 * 1024
	MaxPreviewRunes     = 140
	MaxPathBytes        = 4096
	// The user's prompts kept for the workspace task checkpoint (FR-CONT-007): the first, and the latest ones.
	MaxPrompts     = 50
	MaxPromptBytes = 4096

	// A transcript whose first lines are none of the records its adapter knows is a format it does not read.
	unsupportedMinLines = 5
)

// must match frontend/moltenterm-shell/companion/companion-model.ts
const (
	TodoPending    = "pending"
	TodoInProgress = "in_progress"
	TodoCompleted  = "completed"

	FileAdded   = "add"
	FileUpdated = "update"
	FileDeleted = "delete"
)

// Prompt is one prompt of the user, on one line, without the agent's markup.
type Prompt struct {
	Text string `json:"text"`
	At   int64  `json:"at,omitempty"`
}

type Todo struct {
	Text   string `json:"text"`
	Status string `json:"status"`
}

type ToolCall struct {
	Id   string `json:"id"`
	Tool string `json:"tool"`
	// Args: the call's arguments as compact JSON (or text), cut to MaxArgsBytes.
	Args string `json:"args,omitempty"`
	At   int64  `json:"at,omitempty"`
	// Approval: the transcript itself says the agent asks for permission (Codex's approval requests). Otherwise a
	// pending call is a permission request only while the agent waits.
	Approval bool `json:"approval,omitempty"`
}

type answer struct {
	index int
	at    int64
	texts []string
	size  int
	// A tool call after the last text: the next text starts a new answer of the same turn (the text after the last
	// tool call is the turn's answer; the earlier ones narrate the work).
	toolSinceText bool
	hasText       bool
	// rev changes with the text, so a view can tell its copy of the answer is current; preview is kept, not
	// recomputed for every view.
	rev     int64
	preview string
}

func (a *answer) markdown() string {
	return strings.Join(a.texts, "\n\n")
}

type fileChange struct {
	path    string
	kind    string
	added   int
	removed int
	at      int64
	seq     int64
	edits   int
	chunks  []string
	size    int
	// Truncated: older edits were dropped to keep the diff under MaxDiffBytes.
	truncated bool
}

// Session is the normalised state of one transcript. Adapters feed it; it never holds more than its caps.
type Session struct {
	Version int64
	Format  string
	// Id: the agent's session id, when its transcript says it.
	Id string
	// Cwd: the agent's folder when its transcript says it, for the relative paths of its edits.
	Cwd         string
	lines       int
	parsed      int
	known       int
	turns       []*answer
	nextTurn    int
	files       map[string]*fileChange
	fileSeq     int64
	diffBytes   int
	todos       []Todo
	pending     []ToolCall
	editedCalls map[string]bool
	// Codex's plan limits, from its token_count events (FR-SHELL-029): read by the usage source, not the view, so
	// they change limitsRev and not Version.
	codexLimits usage.CodexTranscriptLimits
	limitsRev   int64
	// What the task checkpoint reads (FR-CONT-007): the prompts, when the task list last changed, the turns ended.
	firstPrompt *Prompt
	prompts     []Prompt
	todosAt     int64
	turnsEnded  int
	// recordAt: the time of the record being parsed, for the changes whose call does not carry it.
	recordAt int64
	// lean: no diff is kept (a reader that only needs which files changed).
	lean bool
}

func MakeSession() *Session {
	return &Session{files: map[string]*fileChange{}, editedCalls: map[string]bool{}}
}

// MakeLeanSession is a session that keeps no diff: the files changed are counted, their hunks dropped.
func MakeLeanSession() *Session {
	s := MakeSession()
	s.lean = true
	return s
}

// SetRecordTime gives the time of the record about to be parsed (0 when the record has none).
func (s *Session) SetRecordTime(at int64) {
	if at > 0 {
		s.recordAt = at
	}
}

// AddPrompt keeps a prompt of the user, already cleaned of the agent's markup. It does not change Version: the
// companion view does not show prompts.
func (s *Session) AddPrompt(text string, at int64) {
	text = strings.TrimSpace(oneLine(text))
	if text == "" {
		return
	}
	p := Prompt{Text: cutString(text, MaxPromptBytes), At: at}
	if s.firstPrompt == nil {
		first := p
		s.firstPrompt = &first
	}
	s.prompts = append(s.prompts, p)
	if len(s.prompts) > MaxPrompts {
		s.prompts = append([]Prompt(nil), s.prompts[len(s.prompts)-MaxPrompts:]...)
	}
}

func (s *Session) touch() {
	s.Version++
}

// AddCodexRateLimits keeps a token_count event's `rate_limits` (FR-SHELL-029).
func (s *Session) AddCodexRateLimits(rateLimits any, at int64) {
	s.codexLimits.Add(rateLimits, at)
	s.limitsRev++
}

// ClearCodexLimits forgets the plan limits read so far (NFR-SHELL-011).
func (s *Session) ClearCodexLimits() {
	if len(s.codexLimits.Records) == 0 && !s.codexLimits.NoLimits {
		return
	}
	s.codexLimits = usage.CodexTranscriptLimits{}
	s.limitsRev++
}

func (s *Session) LimitsRev() int64 {
	return s.limitsRev
}

// CodexLimits returns the plan limits read so far and their revision.
func (s *Session) CodexLimits() (usage.CodexTranscriptLimits, int64) {
	return s.codexLimits.Copy(), s.limitsRev
}

// Unsupported tells that the transcript is not in a format its adapter reads: enough lines, none recognised, or
// most of them not even JSON.
func (s *Session) Unsupported() bool {
	if s.lines < unsupportedMinLines {
		return false
	}
	if s.known == 0 {
		return true
	}
	return s.lines >= 2*unsupportedMinLines && s.parsed*2 < s.lines
}

func (s *Session) countLine(parsed bool, known bool) {
	s.lines++
	if parsed {
		s.parsed++
	}
	if known {
		s.known++
	}
}

func (s *Session) currentTurn() *answer {
	if len(s.turns) == 0 {
		return nil
	}
	return s.turns[len(s.turns)-1]
}

// StartTurn opens a new turn (the user sent a prompt). A turn with nothing in it yet is reused, so the several
// records a prompt makes (Codex's task_started and user_message) make one turn. The previous turn's pending calls
// are over: the user answered, or interrupted them.
func (s *Session) StartTurn(at int64) {
	if len(s.pending) > 0 {
		s.pending = nil
		s.touch()
	}
	cur := s.currentTurn()
	if cur != nil && !cur.hasText && !cur.toolSinceText {
		cur.at = at
		return
	}
	s.nextTurn++
	s.turns = append(s.turns, &answer{index: s.nextTurn, at: at})
	s.trimTurns()
	s.touch()
}

func (s *Session) trimTurns() {
	if len(s.turns) <= MaxAnswers {
		return
	}
	s.turns = s.turns[len(s.turns)-MaxAnswers:]
}

func (s *Session) ensureTurn(at int64) *answer {
	cur := s.currentTurn()
	if cur == nil {
		s.nextTurn++
		cur = &answer{index: s.nextTurn, at: at}
		s.turns = append(s.turns, cur)
	}
	return cur
}

// AddText adds assistant text (markdown) to the current turn's answer.
func (s *Session) AddText(text string, at int64) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	cur := s.ensureTurn(at)
	if cur.toolSinceText {
		cur.texts = nil
		cur.size = 0
		cur.toolSinceText = false
	}
	text = cutString(text, MaxAnswerBytes)
	cur.texts = append(cur.texts, text)
	cur.size += len(text)
	for cur.size > MaxAnswerBytes && len(cur.texts) > 1 {
		cur.size -= len(cur.texts[0])
		cur.texts = cur.texts[1:]
	}
	cur.hasText = true
	cur.rev++
	cur.preview = preview(text)
	if at > 0 {
		cur.at = at
	}
	s.touch()
}

// AddToolCall records a call the agent makes; it stays pending until its result comes.
func (s *Session) AddToolCall(id string, tool string, args string, at int64) {
	cur := s.ensureTurn(at)
	if cur.hasText {
		cur.toolSinceText = true
	}
	if id == "" {
		s.touch()
		return
	}
	s.removePending(id)
	s.pending = append(s.pending, ToolCall{Id: cutString(id, 200), Tool: cutString(tool, 200), Args: cutString(args, MaxArgsBytes), At: at})
	if len(s.pending) > MaxPending {
		s.pending = s.pending[len(s.pending)-MaxPending:]
	}
	s.touch()
}

// MarkApproval records an explicit permission request (the call may not have been seen as a tool call).
func (s *Session) MarkApproval(id string, tool string, args string, at int64) {
	for i := range s.pending {
		if id != "" && s.pending[i].Id == id {
			s.pending[i].Approval = true
			if args != "" {
				s.pending[i].Args = cutString(args, MaxArgsBytes)
			}
			s.touch()
			return
		}
	}
	s.pending = append(s.pending, ToolCall{Id: cutString(id, 200), Tool: cutString(tool, 200), Args: cutString(args, MaxArgsBytes), At: at, Approval: true})
	if len(s.pending) > MaxPending {
		s.pending = s.pending[len(s.pending)-MaxPending:]
	}
	s.touch()
}

func (s *Session) removePending(id string) bool {
	for i := range s.pending {
		if s.pending[i].Id == id {
			s.pending = append(s.pending[:i:i], s.pending[i+1:]...)
			return true
		}
	}
	return false
}

// ResolveTool ends a pending call (its result arrived, or the agent started running it).
func (s *Session) ResolveTool(id string) {
	if id == "" {
		return
	}
	if s.removePending(id) {
		s.touch()
	}
}

// EndTurn: the agent finished its turn, nothing it asked is pending any more.
func (s *Session) EndTurn() {
	s.turnsEnded++
	if len(s.pending) == 0 {
		return
	}
	s.pending = nil
	s.touch()
}

// SetTodos replaces the task list.
func (s *Session) SetTodos(todos []Todo) {
	if len(todos) > MaxTodos {
		todos = todos[:MaxTodos]
	}
	for i := range todos {
		todos[i].Text = cutString(oneLine(todos[i].Text), MaxTodoText)
		todos[i].Status = normaliseTodoStatus(todos[i].Status)
	}
	s.todos = todos
	s.todosAt = s.recordAt
	s.touch()
}

// UpsertTodo adds a task or updates one by its key (Claude Code's TaskCreate / TaskUpdate).
func (s *Session) UpsertTodo(index int, text string, status string) {
	if index < 0 || index >= MaxTodos {
		return
	}
	for len(s.todos) <= index {
		s.todos = append(s.todos, Todo{Status: TodoPending})
	}
	if text != "" {
		s.todos[index].Text = cutString(oneLine(text), MaxTodoText)
	}
	if status != "" {
		s.todos[index].Status = normaliseTodoStatus(status)
	}
	s.todosAt = s.recordAt
	s.touch()
}

func normaliseTodoStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done":
		return TodoCompleted
	case "in_progress", "in-progress", "inprogress", "active", "running":
		return TodoInProgress
	}
	return TodoPending
}

// EditSeen tells whether a call's file edit was already recorded (an agent can report the same edit twice).
func (s *Session) EditSeen(callId string) bool {
	if callId == "" {
		return false
	}
	if s.editedCalls[callId] {
		return true
	}
	if len(s.editedCalls) > 4*MaxFiles {
		s.editedCalls = map[string]bool{}
	}
	s.editedCalls[callId] = true
	return false
}

// AddFileEdit records a change of a file; diff holds unified diff hunks ("@@ ... @@" and +, -, space lines).
func (s *Session) AddFileEdit(path string, kind string, diff string, at int64) {
	if path == "" || len(path) > MaxPathBytes {
		return
	}
	s.fileSeq++
	fc := s.files[path]
	if fc == nil {
		fc = &fileChange{path: path, kind: kind}
		s.files[path] = fc
	} else if kind == FileDeleted || fc.kind == FileDeleted || (fc.kind != FileAdded && kind == FileAdded) {
		fc.kind = kind
	}
	fc.at = at
	fc.seq = s.fileSeq
	fc.edits++
	added, removed := countDiff(diff)
	fc.added += added
	fc.removed += removed
	if diff != "" && !s.lean {
		diff = cutString(diff, MaxDiffBytes)
		if !strings.HasSuffix(diff, "\n") {
			diff += "\n"
		}
		fc.chunks = append(fc.chunks, diff)
		fc.size += len(diff)
		s.diffBytes += len(diff)
		for fc.size > MaxDiffBytes && len(fc.chunks) > 1 {
			fc.size -= len(fc.chunks[0])
			s.diffBytes -= len(fc.chunks[0])
			fc.chunks = fc.chunks[1:]
			fc.truncated = true
		}
	}
	if len(s.files) > MaxFiles {
		s.dropOldestFile()
	}
	s.trimDiffs()
	s.touch()
}

func (s *Session) dropOldestFile() {
	var oldest *fileChange
	for _, fc := range s.files {
		if oldest == nil || fc.seq < oldest.seq {
			oldest = fc
		}
	}
	if oldest != nil {
		s.diffBytes -= oldest.size
		delete(s.files, oldest.path)
	}
}

// trimDiffs keeps the session's diffs under MaxSessionDiffBytes: the least recently changed files lose theirs first
// (their counts stay).
func (s *Session) trimDiffs() {
	if s.diffBytes <= MaxSessionDiffBytes {
		return
	}
	list := make([]*fileChange, 0, len(s.files))
	for _, fc := range s.files {
		if fc.size > 0 {
			list = append(list, fc)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].seq < list[j].seq })
	for _, fc := range list {
		if s.diffBytes <= MaxSessionDiffBytes {
			return
		}
		s.diffBytes -= fc.size
		fc.chunks, fc.size, fc.truncated = nil, 0, true
	}
}

func countDiff(diff string) (int, int) {
	added, removed := 0, 0
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		case strings.HasPrefix(line, "+"):
			added++
		case strings.HasPrefix(line, "-"):
			removed++
		}
	}
	return added, removed
}

// Views: what the companion shows (companion-model.ts reads the same JSON).

type AnswerInfo struct {
	Index   int    `json:"index"`
	At      int64  `json:"at,omitempty"`
	Preview string `json:"preview"`
}

type AnswerView struct {
	Rev      int64  `json:"rev"`
	Index    int    `json:"index"`
	At       int64  `json:"at,omitempty"`
	Markdown string `json:"markdown"`
	// Latest: the answer of the turn in progress or of the last turn.
	Latest bool `json:"latest,omitempty"`
	// Elided: an event left the markdown out, unchanged since the previous event.
	Elided bool `json:"elided,omitempty"`
}

type FileInfo struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Added     int    `json:"added"`
	Removed   int    `json:"removed"`
	At        int64  `json:"at,omitempty"`
	Edits     int    `json:"edits"`
	Truncated bool   `json:"truncated,omitempty"`
}

type FileDiff struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated,omitempty"`
}

func (s *Session) answered() []*answer {
	rtn := make([]*answer, 0, len(s.turns))
	for _, t := range s.turns {
		if t.hasText {
			rtn = append(rtn, t)
		}
	}
	return rtn
}

func (s *Session) Answers() []AnswerInfo {
	turns := s.answered()
	rtn := make([]AnswerInfo, 0, len(turns))
	for _, t := range turns {
		rtn = append(rtn, AnswerInfo{Index: t.index, At: t.at, Preview: t.preview})
	}
	return rtn
}

// Answer returns the answer of a turn, or the latest one for index 0.
func (s *Session) Answer(index int) (AnswerView, bool) {
	turns := s.answered()
	if len(turns) == 0 {
		return AnswerView{}, false
	}
	last := turns[len(turns)-1]
	if index <= 0 {
		return AnswerView{Index: last.index, Rev: last.rev, At: last.at, Markdown: last.markdown(), Latest: true}, true
	}
	for _, t := range turns {
		if t.index == index {
			return AnswerView{Index: t.index, Rev: t.rev, At: t.at, Markdown: t.markdown(), Latest: t == last}, true
		}
	}
	return AnswerView{}, false
}

// Files lists the files changed, the most recently changed first.
func (s *Session) Files() []FileInfo {
	list := make([]*fileChange, 0, len(s.files))
	for _, fc := range s.files {
		list = append(list, fc)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].seq > list[j].seq })
	rtn := make([]FileInfo, 0, len(list))
	for _, fc := range list {
		rtn = append(rtn, FileInfo{Path: fc.path, Kind: fc.kind, Added: fc.added, Removed: fc.removed, At: fc.at, Edits: fc.edits, Truncated: fc.truncated})
	}
	return rtn
}

func (s *Session) Diff(path string) (FileDiff, bool) {
	fc := s.files[path]
	if fc == nil {
		return FileDiff{}, false
	}
	return FileDiff{Path: fc.path, Kind: fc.kind, Diff: strings.Join(fc.chunks, ""), Truncated: fc.truncated}, true
}

func (s *Session) Todos() []Todo {
	return append([]Todo(nil), s.todos...)
}

func (s *Session) Pending() []ToolCall {
	return append([]ToolCall(nil), s.pending...)
}

// SessionDigest is what the workspace task checkpoint reads of a session (FR-CONT-007): never an answer or a diff.
type SessionDigest struct {
	Id     string `json:"id,omitempty"`
	Format string `json:"format,omitempty"`
	Cwd    string `json:"cwd,omitempty"`
	// FirstPrompt: the session's first prompt; Prompts: the latest ones, oldest first.
	FirstPrompt *Prompt    `json:"firstprompt,omitempty"`
	Prompts     []Prompt   `json:"prompts,omitempty"`
	Todos       []Todo     `json:"todos,omitempty"`
	TodosAt     int64      `json:"todosat,omitempty"`
	Files       []FileInfo `json:"files,omitempty"`
	TurnsEnded  int        `json:"turnsended,omitempty"`
}

func (s *Session) Digest() SessionDigest {
	d := SessionDigest{
		Id:         s.Id,
		Format:     s.Format,
		Cwd:        s.Cwd,
		Prompts:    append([]Prompt(nil), s.prompts...),
		Todos:      s.Todos(),
		TodosAt:    s.todosAt,
		Files:      s.Files(),
		TurnsEnded: s.turnsEnded,
	}
	if s.firstPrompt != nil {
		first := *s.firstPrompt
		d.FirstPrompt = &first
	}
	return d
}

func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func preview(text string) string {
	clean := oneLine(text)
	if utf8.RuneCountInString(clean) <= MaxPreviewRunes {
		return clean
	}
	return string([]rune(clean)[:MaxPreviewRunes-1]) + "…"
}

// cutString keeps at most max bytes, on a rune boundary.
func cutString(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	// A copy: the cut part must not keep the whole original in memory.
	return strings.Clone(text[:cut])
}
