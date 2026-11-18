// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
)

// His agent's permission requests, in his layer (#2257): the developer never has to open his terminal to let him run a
// command or edit a file. The request comes through the agent's own PermissionRequest hook (Claude Code's and Codex's
// structured hook, `molten agent permission`, which MoltenTerm's launcher adds), never from the screen of his
// terminal: the hook hands it to wavesrv, which keeps it until the developer answers in his talk window, and the
// hook gives the answer back to the agent as the hook's own decision.
//
//   - Each request has an id of its own, random, kept in memory: an answer counts only for the request still waiting
//     under that id in that terminal, so no answer is ever replayed after a restart, after the hook gave up, or after
//     a newer request of the same agent took its place (it was answered in his terminal).
//   - A request MoltenTerm cannot read for sure (a tool it does not know, a field that is not what it expects) is
//     never guessed at: it goes to his terminal's own prompt, and the window says so plainly.
//   - Nothing is approved without the developer, unless he turned boss:autoapprove on himself; even then the guarded
//     requests (permitguard.go) still ask, and each approval shows as a line in his talk window.

const (
	PermitCommand = "moltenbrokkpermit"

	// Decisions the window sends.
	PermitAllow  = "allow"
	PermitAlways = "always"
	PermitDeny   = "deny"

	// Kinds of request, as the window words them.
	PermitKindCommand = "command"
	PermitKindEdit    = "edit"
	PermitKindWrite   = "write"
	PermitKindRead    = "read"
	PermitKindFetch   = "fetch"
	PermitKindSearch  = "search"
	// PermitKindPatch: Codex's apply_patch; the subject lists "add|update|delete <path>", one per line.
	PermitKindPatch = "patch"
	// PermitKindFind: files searched by name (Glob); the subject is the pattern, after its folder when one is named.
	PermitKindFind = "find"
	// PermitKindGrep: the content of files searched (Grep); the subject is the pattern, then the folder and the file
	// filter, one per line.
	PermitKindGrep = "grep"
	// PermitKindTool: a tool of an MCP server; the subject is the tool's name, then its input as sent.
	PermitKindTool = "tool"
	// PermitKindQuestion: his agent asks the developer (Claude Code's AskUserQuestion, #2382); Questions holds them.
	PermitKindQuestion = "question"

	// PermitAnswer: the developer's answers to a question (PermitRequest.Answers).
	PermitAnswer = "answer"

	// Results of an answer.
	PermitAnswered = "answered"
	PermitGone     = "gone"
	PermitInvalid  = "invalid"

	maxPermitSubject = 2000
	// A question of his agent (AskUserQuestion, a multiple-choice question): at most this many questions, at least and
	// at most this many choices, at most this many characters in a question, a label, a description and an answer. A
	// question past these is not read: his terminal asks it.
	maxQuestions        = 4
	minChoices          = 2
	maxChoices          = 10
	maxQuestionText     = 480
	maxChoiceLabel      = 200
	maxChoiceDetail     = 1000
	maxQuestionAnswer   = MaxTextLength
	askUserQuestionTool = "AskUserQuestion"
	mcpToolPrefix       = "mcp__"
	// How many approvals made without asking the window keeps, and for how long.
	maxAutoApprovals = 50
	autoApprovalKeep = 30 * time.Minute

	denyMessage = "The developer denied this in MoltenTerm."

	// How often a waiting request checks whether his agent went on without it, and how long after the request a new
	// state counts as going on (the request's own waiting may come a moment after it).
	permitMovedEvery   = time.Second
	permitMovedSlackMs = 1000
)

// AutoApproveConsentKey is the developer's confirmation of boss:autoapprove, written by the window in the client's
// meta when he confirms it, removed when he turns it off (#2257). A terminal cannot write molten:* keys on the client
// (pkg/molten/metaguard), nor set boss:autoapprove (pkg/wshrpc/wshserver configguard); an agent writing settings.json
// by hand gets the setting without the confirmation, which counts as off.
const AutoApproveConsentKey = "molten:brokkautoapprove"

// AutoApproveOn: the setting and the developer's confirmation agree.
func AutoApproveOn(setting bool, clientMeta map[string]any) bool {
	if !setting {
		return false
	}
	at, ok := clientMeta[AutoApproveConsentKey].(float64)
	return ok && at > 0
}

// PermissionAsk is a request as the window shows it: what is asked (Kind), the exact command or path (Subject), and
// whether the agent offers to always allow it.
type PermissionAsk struct {
	Id      string `json:"id"`
	BlockId string `json:"blockid"`
	Agent   string `json:"agent,omitempty"`
	Tool    string `json:"tool"`
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	Always  bool   `json:"always,omitempty"`
	At      int64  `json:"at"`
	// Questions: what a question asks (PermitKindQuestion), each with its choices.
	Questions []AgentQuestion `json:"questions,omitempty"`
	// Cwd: where his agent runs it, for the guard (permitguard.go); not shown.
	Cwd string `json:"-"`
}

// AgentQuestion is one question of his agent to the developer, as AskUserQuestion sends it: the question, its short
// header, its choices, and whether several may be picked.
type AgentQuestion struct {
	Question    string        `json:"question"`
	Header      string        `json:"header,omitempty"`
	Options     []AgentChoice `json:"options"`
	MultiSelect bool          `json:"multiselect,omitempty"`
}

type AgentChoice struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// AutoApproval is a request boss:autoapprove let through, for the line in his talk window.
type AutoApproval struct {
	Id      string `json:"id"`
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	At      int64  `json:"at"`
}

// PermitRequest is the window's answer to one request.
type PermitRequest struct {
	Id       string `json:"id"`
	BlockId  string `json:"blockid"`
	Decision string `json:"decision"`
	// Answers: with PermitAnswer, the developer's answer to each question, by the question's text.
	Answers map[string]string `json:"answers,omitempty"`
}

type PermitResult struct {
	Status string `json:"status"`
}

type pendingAsk struct {
	ask         PermissionAsk
	suggestions []any
	// input: the tool's input as his agent sent it, given back with a question's answers.
	input  map[string]any
	answer chan permitAnswer
	// gone is closed when a newer request of the same terminal takes its place.
	gone chan struct{}
}

type permitAnswer struct {
	decision string
	answers  map[string]string
}

// PermitEnv is what the broker reaches outside itself; the tests give fakes.
type PermitEnv struct {
	// IsOwn tells whether the block is his session's.
	IsOwn func(ctx context.Context, blockId string) bool
	// AutoApprove reads boss:autoapprove, read at each request: turning it off applies to the next one.
	AutoApprove func() bool
	// Guard names why a request still asks with boss:autoapprove on, "" when it may go (permitguard.go).
	Guard func(ask PermissionAsk) string
	// Approvals keeps the approvals made without asking (approvallog.go): written before the agent gets the allow, read
	// by the window, so a burst or a restart loses none. nil: kept in memory only.
	Approvals *ApprovalLog
	// Moved tells whether his agent reported a state other than waiting after at (Unix milliseconds): it went on,
	// the request was answered elsewhere.
	Moved func(blockId string, at int64) bool
	NewId func() string
	Now   func() time.Time
}

type PermitBroker struct {
	env PermitEnv

	lock    sync.Mutex
	pending map[string]*pendingAsk
	auto    []AutoApproval
	// changed is told when a request comes or goes (the talk shows it in every window at once, #2382).
	changed func()
}

// OnChange sets what is told when a request comes or goes; it is called outside the broker's lock.
func (b *PermitBroker) OnChange(fn func()) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.changed = fn
}

func (b *PermitBroker) changedFn() func() {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.changed
}

func (b *PermitBroker) notify() {
	if fn := b.changedFn(); fn != nil {
		fn()
	}
}

func MakePermitBroker(env PermitEnv) *PermitBroker {
	if env.NewId == nil {
		env.NewId = newPermitId
	}
	if env.Now == nil {
		env.Now = time.Now
	}
	return &PermitBroker{env: env, pending: map[string]*pendingAsk{}}
}

func newPermitId() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// Ask is keepawake's OwnSessionAsker: it answers the requests of his session's terminal, and only those.
func (b *PermitBroker) Ask(ctx context.Context, req keepawake.PermissionRequest) (keepawake.PermissionAnswer, bool) {
	if !req.FromBlock || req.BlockId == "" || b.env.IsOwn == nil || !b.env.IsOwn(ctx, req.BlockId) {
		return keepawake.PermissionAnswer{}, false
	}
	ask, readable := MapPermission(req)
	if !readable {
		// Never a guess: his agent's own prompt asks, and the window says so (needsanswer, his terminal aside).
		return keepawake.PermissionAnswer{}, true
	}
	ask.Id, ask.BlockId, ask.At = b.env.NewId(), req.BlockId, b.env.Now().UnixMilli()
	// A question is the developer's to answer: boss:autoapprove never answers it.
	autoApprovable := ask.Kind != PermitKindQuestion
	if autoApprovable && b.env.AutoApprove != nil && b.env.AutoApprove() && (b.env.Guard == nil || b.env.Guard(ask) == "") {
		// Nothing runs unseen: an approval that could not be written down asks instead.
		if b.noteAuto(ask) {
			return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, true
		}
	}
	p := b.add(ask, req.Suggestions, req.ToolInput)
	b.notify()
	defer b.notify()
	defer b.remove(p)
	ticker := time.NewTicker(permitMovedEvery)
	defer ticker.Stop()
	for {
		select {
		case answer := <-p.answer:
			return answerOf(answer, p.suggestions, p.input), true
		case <-p.gone:
			return keepawake.PermissionAnswer{}, true
		case <-ctx.Done():
			// Left to his agent's own prompt: the hook prints nothing.
			return keepawake.PermissionAnswer{}, true
		case <-ticker.C:
			// His agent went on (answered in his terminal): the request is over, and no answer may reach it.
			if b.env.Moved != nil && b.env.Moved(ask.BlockId, ask.At) {
				return keepawake.PermissionAnswer{}, true
			}
		}
	}
}

func answerOf(answer permitAnswer, suggestions []any, input map[string]any) keepawake.PermissionAnswer {
	switch answer.decision {
	case PermitAllow:
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}
	case PermitAlways:
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow, Updated: suggestions}
	case PermitAnswer:
		// The question tool reads the developer's answers from its own input (questions, answers).
		updated := make(map[string]any, len(input)+1)
		for k, v := range input {
			updated[k] = v
		}
		answers := make(map[string]any, len(answer.answers))
		for k, v := range answer.answers {
			answers[k] = v
		}
		updated["answers"] = answers
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow, Input: updated}
	}
	return keepawake.PermissionAnswer{Decision: keepawake.PermissionDeny, Message: denyMessage}
}

// add keeps the request, in place of an older one of the same terminal: an agent asks one thing at a time, so an older
// request still kept was answered in his terminal and its hook is gone.
func (b *PermitBroker) add(ask PermissionAsk, suggestions []any, input map[string]any) *pendingAsk {
	p := &pendingAsk{ask: ask, suggestions: suggestions, input: input, answer: make(chan permitAnswer, 1), gone: make(chan struct{})}
	b.lock.Lock()
	defer b.lock.Unlock()
	for id, old := range b.pending {
		if old.ask.BlockId == ask.BlockId {
			close(old.gone)
			delete(b.pending, id)
		}
	}
	b.pending[ask.Id] = p
	return p
}

func (b *PermitBroker) remove(p *pendingAsk) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if b.pending[p.ask.Id] == p {
		delete(b.pending, p.ask.Id)
	}
}

func (b *PermitBroker) noteAuto(ask PermissionAsk) bool {
	approval := AutoApproval{Id: ask.Id, Kind: ask.Kind, Subject: ask.Subject, At: ask.At}
	if b.env.Approvals != nil {
		return b.env.Approvals.Append(approval) == nil
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	b.auto = append(b.auto, approval)
	if len(b.auto) > maxAutoApprovals {
		b.auto = b.auto[len(b.auto)-maxAutoApprovals:]
	}
	return true
}

// Answer gives the developer's decision to the request waiting under that id in that terminal; anything else is gone.
// A question takes answers (PermitAnswer) or a deny, a permission an allow, an always allow (when offered) or a deny.
func (b *PermitBroker) Answer(req PermitRequest) PermitResult {
	if req.Decision != PermitAllow && req.Decision != PermitAlways && req.Decision != PermitDeny && req.Decision != PermitAnswer {
		return PermitResult{Status: PermitInvalid}
	}
	result := b.answer(req)
	if result.Status == PermitAnswered {
		b.notify()
	}
	return result
}

func (b *PermitBroker) answer(req PermitRequest) PermitResult {
	b.lock.Lock()
	defer b.lock.Unlock()
	p := b.pending[req.Id]
	if p == nil || req.Id == "" || p.ask.BlockId != req.BlockId {
		return PermitResult{Status: PermitGone}
	}
	question := p.ask.Kind == PermitKindQuestion
	if req.Decision == PermitAlways && (!p.ask.Always || question) {
		return PermitResult{Status: PermitInvalid}
	}
	if question && req.Decision == PermitAllow {
		return PermitResult{Status: PermitInvalid}
	}
	var answers map[string]string
	if req.Decision == PermitAnswer {
		var ok bool
		if answers, ok = questionAnswers(p.ask.Questions, req.Answers); !question || !ok {
			return PermitResult{Status: PermitInvalid}
		}
	}
	delete(b.pending, req.Id)
	p.answer <- permitAnswer{decision: req.Decision, answers: answers}
	return PermitResult{Status: PermitAnswered}
}

// questionAnswers checks the developer's answers: one for each question, by its text, none for another, each a text
// of its own (a choice's label, several joined, or what the developer wrote), without control characters but the line
// breaks.
func questionAnswers(questions []AgentQuestion, answers map[string]string) (map[string]string, bool) {
	if len(questions) == 0 || len(answers) != len(questions) {
		return nil, false
	}
	rtn := make(map[string]string, len(questions))
	for _, q := range questions {
		answer, ok := answers[q.Question]
		answer = strings.TrimSpace(controlRuns.ReplaceAllString(answer, " "))
		if !ok || answer == "" || utf8.RuneCountInString(answer) > maxQuestionAnswer {
			return nil, false
		}
		rtn[q.Question] = answer
	}
	return rtn, true
}

var controlRuns = regexp.MustCompile("[\x00-\x09\x0b-\x1f\x7f]+")

// Pending is the request waiting in the terminal, if any.
func (b *PermitBroker) Pending(blockId string) *PermissionAsk {
	b.lock.Lock()
	defer b.lock.Unlock()
	for _, p := range b.pending {
		if p.ask.BlockId == blockId {
			return copyAsk(p.ask)
		}
	}
	return nil
}

// PendingAny is the request waiting, whatever the terminal: the broker keeps only his session's (Ask checks IsOwn), and
// the talk shows it before it knows his terminal (a restart, #2382). The newest one when two terminals ever asked.
func (b *PermitBroker) PendingAny() *PermissionAsk {
	b.lock.Lock()
	defer b.lock.Unlock()
	var newest *pendingAsk
	for _, p := range b.pending {
		if newest == nil || p.ask.At > newest.ask.At || (p.ask.At == newest.ask.At && p.ask.Id > newest.ask.Id) {
			newest = p
		}
	}
	if newest == nil {
		return nil
	}
	return copyAsk(newest.ask)
}

func copyAsk(ask PermissionAsk) *PermissionAsk {
	rtn := ask
	if ask.Questions != nil {
		rtn.Questions = make([]AgentQuestion, len(ask.Questions))
		for i, q := range ask.Questions {
			rtn.Questions[i] = q
			rtn.Questions[i].Options = append([]AgentChoice{}, q.Options...)
		}
	}
	return &rtn
}

// AutoApproved lists the approvals made without asking since after (Unix milliseconds), of the last half hour.
func (b *PermitBroker) AutoApproved(after int64) []AutoApproval {
	since := max(after, b.env.Now().Add(-autoApprovalKeep).UnixMilli())
	if b.env.Approvals != nil {
		return b.env.Approvals.Since(since, maxAutoApprovals)
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	var rtn []AutoApproval
	for _, a := range b.auto {
		if a.At >= since {
			rtn = append(rtn, a)
		}
	}
	return rtn
}

// MapPermission reads a request in plain terms: false when MoltenTerm cannot be sure what it asks. Claude Code's tools
// by their names and fields; Codex sends the same input for its shell tool.
func MapPermission(req keepawake.PermissionRequest) (PermissionAsk, bool) {
	ask := PermissionAsk{Agent: req.Agent, Tool: req.ToolName, Always: len(req.Suggestions) > 0, Cwd: req.Cwd}
	field := func(name string) (string, bool) {
		v, ok := req.ToolInput[name].(string)
		v = strings.TrimSpace(v)
		return v, ok && v != ""
	}
	// The fields a card shows on lines of their own: each one there must be a text without a line break, or the request
	// is not read (a break would read as another line of the card).
	oneLine := func(names ...string) bool {
		for _, name := range names {
			raw, present := req.ToolInput[name]
			if !present || raw == nil {
				continue
			}
			s, isText := raw.(string)
			if !isText || strings.ContainsAny(s, "\r\n") {
				return false
			}
		}
		return true
	}
	set := func(kind string, subject string) (PermissionAsk, bool) {
		if strings.ContainsAny(subject, "\x00") || len(subject) > maxPermitSubject {
			return PermissionAsk{}, false
		}
		ask.Kind, ask.Subject = kind, subject
		return ask, true
	}
	switch req.ToolName {
	case "Bash", "shell", "local_shell", "exec_command":
		if command, ok := field("command"); ok {
			return set(PermitKindCommand, command)
		}
		if parts, ok := req.ToolInput["command"].([]any); ok && len(parts) > 0 {
			words := make([]string, 0, len(parts))
			for _, p := range parts {
				w, ok := p.(string)
				if !ok {
					return PermissionAsk{}, false
				}
				words = append(words, w)
			}
			return set(PermitKindCommand, strings.Join(words, " "))
		}
	case "Edit", "MultiEdit":
		if path, ok := field("file_path"); ok {
			return set(PermitKindEdit, path)
		}
	case "Write":
		if path, ok := field("file_path"); ok {
			return set(PermitKindWrite, path)
		}
	case "NotebookEdit":
		if path, ok := field("notebook_path"); ok {
			return set(PermitKindEdit, path)
		}
	case "Read":
		if path, ok := field("file_path"); ok {
			return set(PermitKindRead, path)
		}
	case "WebFetch":
		if url, ok := field("url"); ok {
			return set(PermitKindFetch, url)
		}
	case "WebSearch":
		if query, ok := field("query"); ok {
			return set(PermitKindSearch, query)
		}
	case "apply_patch":
		// Codex's patch: the files it touches, each named on its own header line; a patch without one is not read.
		if patch, ok := field("command"); ok {
			if files := patchFiles(patch); len(files) > 0 {
				return set(PermitKindPatch, strings.Join(files, "\n"))
			}
		}
	case "Glob":
		// A search for files by name: the pattern, in its folder when one is named (#2382).
		pattern, ok := field("pattern")
		if !ok || !oneLine("pattern", "path") {
			break
		}
		if dir, ok := field("path"); ok && !strings.HasPrefix(pattern, "/") {
			return set(PermitKindFind, strings.TrimRight(dir, "/")+"/"+pattern)
		}
		return set(PermitKindFind, pattern)
	case "Grep":
		// A search in the files' content: the pattern, then the folder and the file filter it names, one per line (#2382).
		pattern, ok := field("pattern")
		if !ok || !oneLine("pattern", "path", "glob") {
			break
		}
		lines := []string{pattern}
		for _, name := range []string{"path", "glob"} {
			if v, ok := field(name); ok {
				lines = append(lines, v)
			}
		}
		return set(PermitKindGrep, strings.Join(lines, "\n"))
	case "LS":
		if dir, ok := field("path"); ok && oneLine("path") {
			return set(PermitKindRead, dir)
		}
	case askUserQuestionTool:
		// His agent's question to the developer (#2382): answered in his window, never guessed.
		if questions, ok := readQuestions(req.ToolInput); ok {
			texts := make([]string, len(questions))
			for i, q := range questions {
				texts[i] = q.Question
			}
			if ask, ok := set(PermitKindQuestion, strings.Join(texts, "\n")); ok {
				ask.Always, ask.Questions = false, questions
				return ask, true
			}
		}
	default:
		// A tool of an MCP server: its name and its input as sent, which the card shows as they are (#2382).
		if strings.HasPrefix(req.ToolName, mcpToolPrefix) && len(req.ToolName) > len(mcpToolPrefix) {
			input, err := json.Marshal(req.ToolInput)
			if err != nil || req.ToolInput == nil {
				input = []byte("{}")
			}
			return set(PermitKindTool, req.ToolName+"\n"+string(input))
		}
	}
	return PermissionAsk{}, false
}

// readQuestions reads AskUserQuestion's input: one to four questions, each a text with a short header and two to ten
// choices, each choice a label and its description. Anything else is not read.
func readQuestions(input map[string]any) ([]AgentQuestion, bool) {
	list, ok := input["questions"].([]any)
	if !ok || len(list) == 0 || len(list) > maxQuestions {
		return nil, false
	}
	seen := map[string]bool{}
	questions := make([]AgentQuestion, 0, len(list))
	for _, raw := range list {
		obj, ok := raw.(map[string]any)
		if !ok {
			return nil, false
		}
		text, ok := plainText(obj["question"], maxQuestionText, true)
		if !ok || seen[text] {
			return nil, false
		}
		seen[text] = true
		header, ok := plainText(obj["header"], maxChoiceLabel, false)
		if !ok {
			return nil, false
		}
		multi, isBool := obj["multiSelect"].(bool)
		if obj["multiSelect"] != nil && !isBool {
			return nil, false
		}
		options, ok := obj["options"].([]any)
		if !ok || len(options) < minChoices || len(options) > maxChoices {
			return nil, false
		}
		q := AgentQuestion{Question: text, Header: header, MultiSelect: multi, Options: make([]AgentChoice, 0, len(options))}
		labels := map[string]bool{}
		for _, rawOption := range options {
			option, ok := rawOption.(map[string]any)
			if !ok {
				return nil, false
			}
			label, ok := plainText(option["label"], maxChoiceLabel, true)
			if !ok || labels[label] {
				return nil, false
			}
			labels[label] = true
			detail, ok := plainText(option["description"], maxChoiceDetail, false)
			if !ok {
				return nil, false
			}
			q.Options = append(q.Options, AgentChoice{Label: label, Description: detail})
		}
		questions = append(questions, q)
	}
	return questions, true
}

// plainText reads a text of at most max characters with no control character but line breaks; required: it may not
// be missing or empty.
func plainText(value any, max int, required bool) (string, bool) {
	if value == nil {
		return "", !required
	}
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	text = strings.TrimSpace(text)
	if (required && text == "") || utf8.RuneCountInString(text) > max || controlRuns.MatchString(text) {
		return "", false
	}
	return text, true
}

var patchFileLine = regexp.MustCompile(`(?m)^\*\*\* (Add|Update|Delete) File: (.+)$`)

func patchFiles(patch string) []string {
	var files []string
	for _, m := range patchFileLine.FindAllStringSubmatch(patch, -1) {
		files = append(files, strings.ToLower(m[1])+" "+strings.TrimSpace(m[2]))
	}
	return files
}
