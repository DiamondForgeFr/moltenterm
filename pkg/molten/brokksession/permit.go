// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

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

	// Results of an answer.
	PermitAnswered = "answered"
	PermitGone     = "gone"
	PermitInvalid  = "invalid"

	maxPermitSubject = 2000
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
}

type PermitResult struct {
	Status string `json:"status"`
}

type pendingAsk struct {
	ask         PermissionAsk
	suggestions []any
	answer      chan string
	// gone is closed when a newer request of the same terminal takes its place.
	gone chan struct{}
}

// PermitEnv is what the broker reaches outside itself; the tests give fakes.
type PermitEnv struct {
	// IsOwn tells whether the block is his session's.
	IsOwn func(ctx context.Context, blockId string) bool
	// AutoApprove reads boss:autoapprove, read at each request: turning it off applies to the next one.
	AutoApprove func() bool
	// Guard names why a request still asks with boss:autoapprove on, "" when it may go (permitguard.go).
	Guard func(ask PermissionAsk) string
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
	if b.env.AutoApprove != nil && b.env.AutoApprove() && (b.env.Guard == nil || b.env.Guard(ask) == "") {
		b.noteAuto(ask)
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, true
	}
	p := b.add(ask, req.Suggestions)
	defer b.remove(p)
	ticker := time.NewTicker(permitMovedEvery)
	defer ticker.Stop()
	for {
		select {
		case decision := <-p.answer:
			return answerOf(decision, p.suggestions), true
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

func answerOf(decision string, suggestions []any) keepawake.PermissionAnswer {
	switch decision {
	case PermitAllow:
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}
	case PermitAlways:
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow, Updated: suggestions}
	}
	return keepawake.PermissionAnswer{Decision: keepawake.PermissionDeny, Message: denyMessage}
}

// add keeps the request, in place of an older one of the same terminal: an agent asks one thing at a time, so an older
// request still kept was answered in his terminal and its hook is gone.
func (b *PermitBroker) add(ask PermissionAsk, suggestions []any) *pendingAsk {
	p := &pendingAsk{ask: ask, suggestions: suggestions, answer: make(chan string, 1), gone: make(chan struct{})}
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

func (b *PermitBroker) noteAuto(ask PermissionAsk) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.auto = append(b.auto, AutoApproval{Id: ask.Id, Kind: ask.Kind, Subject: ask.Subject, At: ask.At})
	if len(b.auto) > maxAutoApprovals {
		b.auto = b.auto[len(b.auto)-maxAutoApprovals:]
	}
}

// Answer gives the developer's decision to the request waiting under that id in that terminal; anything else is gone.
func (b *PermitBroker) Answer(req PermitRequest) PermitResult {
	if req.Decision != PermitAllow && req.Decision != PermitAlways && req.Decision != PermitDeny {
		return PermitResult{Status: PermitInvalid}
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	p := b.pending[req.Id]
	if p == nil || req.Id == "" || p.ask.BlockId != req.BlockId {
		return PermitResult{Status: PermitGone}
	}
	if req.Decision == PermitAlways && !p.ask.Always {
		return PermitResult{Status: PermitInvalid}
	}
	delete(b.pending, req.Id)
	p.answer <- req.Decision
	return PermitResult{Status: PermitAnswered}
}

// Pending is the request waiting in the terminal, if any.
func (b *PermitBroker) Pending(blockId string) *PermissionAsk {
	b.lock.Lock()
	defer b.lock.Unlock()
	for _, p := range b.pending {
		if p.ask.BlockId == blockId {
			ask := p.ask
			return &ask
		}
	}
	return nil
}

// AutoApproved lists the approvals made without asking since after (Unix milliseconds), of the last half hour.
func (b *PermitBroker) AutoApproved(after int64) []AutoApproval {
	b.lock.Lock()
	defer b.lock.Unlock()
	since := max(after, b.env.Now().Add(-autoApprovalKeep).UnixMilli())
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
	ask := PermissionAsk{Agent: req.Agent, Tool: req.ToolName, Always: len(req.Suggestions) > 0}
	field := func(name string) (string, bool) {
		v, ok := req.ToolInput[name].(string)
		v = strings.TrimSpace(v)
		return v, ok && v != ""
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
	}
	return PermissionAsk{}, false
}

var patchFileLine = regexp.MustCompile(`(?m)^\*\*\* (Add|Update|Delete) File: (.+)$`)

func patchFiles(patch string) []string {
	var files []string
	for _, m := range patchFileLine.FindAllStringSubmatch(patch, -1) {
		files = append(files, strings.ToLower(m[1])+" "+strings.TrimSpace(m[2]))
	}
	return files
}
