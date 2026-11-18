// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Brokk's talk, kept by wavesrv (FR-BOSS-009, AC99, DS-BOSS-015, #2382): there is one Brokk, so one conversation. Each
// tab of MoltenTerm is a page of its own, and the talk used to live in the page that showed it: another workspace showed
// another conversation, another state, another face, and an answer was followed by the timers of a page that a switch
// had hidden. The talk is now here, next to his session: the exchange of each conversation (his ordinary one and the
// brainstorm's, FR-BOSS-010 AC24), the state of the last message, the messages waiting for him, the text a Cancel gave
// back, the lead of the next message and the line under his square. The follow of an answer and the queue run here,
// against his transcript and his agent's state. The windows read the talk after each TalkEvent, which carries a
// revision number only, and act on it through the route; every page shows the same one.

const (
	// must match frontend/moltenterm-shell/boss/brokk-session.ts
	TalkCommand    = "moltenbrokktalk"
	TalkSayCommand = "moltenbrokktalksay"
	TalkOpCommand  = "moltenbrokktalkop"
	TalkEvent      = "molten:brokktalk"

	ConversationMain       = "main"
	ConversationBrainstorm = "brainstorm"

	RoleYou   = "you"
	RoleBrokk = "brokk"

	// Ops of TalkOpCommand.
	TalkOpCancel = "cancel"
	TalkOpClear  = "clearnote"
	TalkOpTake   = "take"
	TalkOpSwitch = "switch"
	TalkOpShow   = "show"
	TalkOpLocal  = "local"
	TalkOpStop   = "stop"
	TalkOpReturn = "return"
	TalkOpReplay = "replay"
	TalkOpLead   = "lead"
	TalkOpWindow = "window"

	// A window's open talk counts for this long after it said so: a page that went away while open does not keep his
	// line from showing for ever. The windows say it again while they stay open.
	windowOpenFor = 5 * time.Minute

	maxKeptTurns    = 400
	maxEntries      = 400
	maxOriginLen    = 128
	maxLeadLength   = 4 * MaxTextLength
	maxAnsweredAsks = 16
)

// TalkEntry is one line of a conversation: a message of the developer (Text) or an answer of his (Markdown, as his agent
// wrote it: the window reads its replies and its tone). An answer has the id of the message it answers.
type TalkEntry struct {
	Id       string `json:"id"`
	Role     string `json:"role"`
	Text     string `json:"text,omitempty"`
	Markdown string `json:"markdown,omitempty"`
	Turn     int    `json:"turn,omitempty"`
	At       int64  `json:"at"`
	Final    bool   `json:"final,omitempty"`
	// Still: a line that offers nothing (a turn kept by a brainstorm, a line MoltenTerm says for him).
	Still bool `json:"still,omitempty"`
	// Taken: a message his agent took; Origin: the page that sent it, whose listeners alone hear it and its answer.
	Taken  bool   `json:"taken,omitempty"`
	Origin string `json:"origin,omitempty"`
}

// TalkWaiting is a message waiting for him while his prompt is taken (#2284), in the conversation it was written in.
type TalkWaiting struct {
	Text         string `json:"text"`
	Since        int64  `json:"since"`
	Conversation string `json:"conversation"`
	lead         string
	origin       string
}

// TalkView is the talk as every window shows it.
type TalkView struct {
	Rev int64 `json:"rev"`
	// Instance tells one wavesrv from the next: a restarted one counts its revisions from 0 again.
	Instance     string            `json:"instance"`
	Conversation string            `json:"conversation"`
	Main         []TalkEntry       `json:"main"`
	Brainstorm   []TalkEntry       `json:"brainstorm"`
	State        TalkState         `json:"state"`
	Waiting      []TalkWaiting     `json:"waiting,omitempty"`
	Returned     map[string]string `json:"returned,omitempty"`
	Lead         string            `json:"lead,omitempty"`
	// Permission: what his agent asks the developer now (a permission or a question, AC100, AC101).
	Permission     *PermissionAsk `json:"permission,omitempty"`
	PermissionGone bool           `json:"permissiongone,omitempty"`
	Approved       []AutoApproval `json:"approved,omitempty"`
	// Unseen: his answer that changed while no window had the talk open, his line under the square (AC25).
	Unseen  string `json:"unseen,omitempty"`
	BlockId string `json:"blockid,omitempty"`
	// InFlight: the conversations a message waits in, or is still answered in.
	InFlight []string `json:"inflight,omitempty"`
}

// TalkSayRequest is a message from a window: the text, the workspace where his tab goes if his session has to start,
// his name for that tab, and the page that sends it.
type TalkSayRequest struct {
	Text        string `json:"text"`
	ClearPrompt bool   `json:"clearprompt,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Name        string `json:"name,omitempty"`
	Origin      string `json:"origin,omitempty"`
}

// KeptTurn is a line a brainstorm kept (conversation.jsonl), shown again when the developer moves to it (#2248).
type KeptTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// TalkOpRequest is one of the window's moves on the talk; each op reads the fields it names.
type TalkOpRequest struct {
	Op           string     `json:"op"`
	Conversation string     `json:"conversation,omitempty"`
	Carry        string     `json:"carry,omitempty"`
	Fresh        bool       `json:"fresh,omitempty"`
	Turns        []KeptTurn `json:"turns,omitempty"`
	Text         string     `json:"text,omitempty"`
	Key          string     `json:"key,omitempty"`
	You          string     `json:"you,omitempty"`
	Markdown     string     `json:"markdown,omitempty"`
	Turn         int        `json:"turn,omitempty"`
	Final        bool       `json:"final,omitempty"`
	Open         bool       `json:"open,omitempty"`
	Origin       string     `json:"origin,omitempty"`
}

// TalkOpResult is the talk after the op, and the text a take gave back.
type TalkOpResult struct {
	Text string   `json:"text,omitempty"`
	View TalkView `json:"view"`
}

// TalkFacts is what his agent's state says now: it works (the ring, background work included), it waits for the
// developer, his prompt is taken (his turn runs or he waits; work he handed to the background leaves it free).
type TalkFacts struct {
	Working    bool
	Waiting    bool
	PromptBusy bool
}

// TalkEnv is what the talk reaches outside itself; the tests give fakes.
type TalkEnv struct {
	Lookup func(ctx context.Context) Result
	Say    func(ctx context.Context, req Request) Result
	// Reply reads his answer; false: the reading failed (counted as one, never "none").
	Reply   func(ctx context.Context, req ReplyRequest) (Reply, bool)
	Facts   func(blockId string) TalkFacts
	Pending func() *PermissionAsk
	Answer  func(req PermitRequest) PermitResult
	Wait    func(d time.Duration)
	Now     func() time.Time
	Publish func(rev int64)
	// Instance is this wavesrv's, for the revisions.
	Instance string
}

// tracked is a message whose answer is followed.
type tracked struct {
	id           string
	conversation string
	origin       string
	text         string
	sentAt       int64
	turn         int
	markdown     string
	stopped      bool
}

type Talk struct {
	env TalkEnv

	lock    sync.Mutex
	rev     int64
	convs   map[string][]TalkEntry
	shown   string
	state   TalkState
	counter int
	// A new message ends the wait of a message that did not leave yet.
	sendGen int
	tracked *tracked
	// The message whose answer writes the state: after a failure nothing does, so its note stays until the developer
	// writes again.
	stateOwner string
	replayed   map[string]*tracked
	waiting    []*TalkWaiting
	returned   map[string]string
	lead       string
	gone       bool
	lastAsk    string
	// The requests a window answered last: a late click on one of them is no news.
	answeredAsks []string
	approved     []AutoApproval
	unseen       string
	blockId      string
	windows      map[string]time.Time
}

func MakeTalk(env TalkEnv) *Talk {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.Wait == nil {
		env.Wait = time.Sleep
	}
	return &Talk{
		env:      env,
		convs:    map[string][]TalkEntry{ConversationMain: {}, ConversationBrainstorm: {}},
		shown:    ConversationMain,
		state:    IdleTalk,
		replayed: map[string]*tracked{},
		returned: map[string]string{},
		windows:  map[string]time.Time{},
	}
}

func (t *Talk) nowMs() int64 {
	return t.env.Now().UnixMilli()
}

// update runs fn under the lock and publishes the new revision when fn changed the talk.
func (t *Talk) update(fn func() bool) {
	rev, changed := t.updateLocked(fn)
	if changed && t.env.Publish != nil {
		t.env.Publish(rev)
	}
}

func (t *Talk) updateLocked(fn func() bool) (int64, bool) {
	t.lock.Lock()
	defer t.lock.Unlock()
	if !fn() {
		return t.rev, false
	}
	t.rev++
	return t.rev, true
}

func (t *Talk) read(fn func()) {
	t.lock.Lock()
	defer t.lock.Unlock()
	fn()
}

// View is the talk as it is now. The request his agent waits on is read from the broker as it is now, so that a card
// shows and goes in every window at once.
func (t *Talk) View() TalkView {
	var view TalkView
	t.read(func() { view = t.viewLocked() })
	if t.env.Pending != nil {
		view.Permission = t.env.Pending()
	}
	return view
}

func (t *Talk) viewLocked() TalkView {
	view := TalkView{
		Rev:            t.rev,
		Instance:       t.env.Instance,
		Conversation:   t.shown,
		Main:           append([]TalkEntry{}, t.convs[ConversationMain]...),
		Brainstorm:     append([]TalkEntry{}, t.convs[ConversationBrainstorm]...),
		State:          t.state,
		Lead:           t.lead,
		PermissionGone: t.gone,
		Approved:       append([]AutoApproval{}, t.approved...),
		Unseen:         t.unseen,
		BlockId:        t.blockId,
	}
	if t.state.Where != nil {
		where := *t.state.Where
		view.State.Where = &where
	}
	for _, w := range t.waiting {
		view.Waiting = append(view.Waiting, *w)
	}
	if len(t.returned) > 0 {
		view.Returned = map[string]string{}
		for k, v := range t.returned {
			view.Returned[k] = v
		}
	}
	for _, key := range []string{ConversationMain, ConversationBrainstorm} {
		if t.inFlightLocked(key) {
			view.InFlight = append(view.InFlight, key)
		}
	}
	return view
}

func (t *Talk) inFlightLocked(key string) bool {
	for _, w := range t.waiting {
		if w.Conversation == key {
			return true
		}
	}
	return t.tracked != nil && !t.tracked.stopped && t.tracked.conversation == key
}

func (t *Talk) nextId(prefix string) string {
	t.counter++
	return fmt.Sprintf("%s%d", prefix, t.counter)
}

func validConversation(key string) bool {
	return key == ConversationMain || key == ConversationBrainstorm
}

func cleanOrigin(origin string) string {
	if len(origin) > maxOriginLen {
		return ""
	}
	return origin
}

func capEntries(entries []TalkEntry) []TalkEntry {
	if len(entries) <= maxEntries {
		return entries
	}
	return entries[len(entries)-maxEntries:]
}

func (t *Talk) appendLocked(key string, entry TalkEntry) {
	t.convs[key] = capEntries(append(t.convs[key], entry))
}

// upsertAnswerLocked puts what he has written so far of the answer to message id in conversation key; the first
// reading adds it after the message. False when nothing changed.
func (t *Talk) upsertAnswerLocked(key string, entry TalkEntry) bool {
	entries := t.convs[key]
	for i := range entries {
		if entries[i].Role != RoleBrokk || entries[i].Id != entry.Id {
			continue
		}
		same := entries[i]
		if same.Markdown == entry.Markdown && same.Final == entry.Final && same.Turn == entry.Turn {
			return false
		}
		entries[i] = entry
		return true
	}
	t.appendLocked(key, entry)
	return true
}

// windowOpenLocked: a window shows the talk open now (AC25: his line under the square is for an answer nobody saw).
func (t *Talk) windowOpenLocked() bool {
	now := t.env.Now()
	for origin, at := range t.windows {
		if now.Sub(at) < windowOpenFor {
			return true
		}
		delete(t.windows, origin)
	}
	return false
}

// keepAnswerLocked writes a reading of his answer to the message tracked in its conversation.
func (t *Talk) keepAnswerLocked(tr *tracked, reply Reply, final bool) bool {
	changed := reply.Markdown != tr.markdown
	tr.markdown = reply.Markdown
	if reply.Index != 0 {
		tr.turn = reply.Index
	}
	at := reply.At
	if at == 0 {
		at = t.nowMs()
	}
	wrote := t.upsertAnswerLocked(tr.conversation, TalkEntry{
		Id: tr.id, Role: RoleBrokk, Markdown: tr.markdown, Turn: tr.turn, At: at, Final: final, Origin: tr.origin,
	})
	if changed && tr.conversation == t.shown && !t.windowOpenLocked() {
		t.unseen = tr.id
	}
	return wrote
}

// finishLocked: his agent is done with the message; what was read of its answer will not change.
func (t *Talk) finishLocked(tr *tracked) bool {
	if tr.markdown == "" {
		return false
	}
	return t.upsertAnswerLocked(tr.conversation, TalkEntry{
		Id: tr.id, Role: RoleBrokk, Markdown: tr.markdown, Turn: tr.turn, At: t.nowMs(), Final: true, Origin: tr.origin,
	})
}

// Op applies one of the window's moves and returns the talk after it.
func (t *Talk) Op(req TalkOpRequest) (TalkOpResult, error) {
	var text string
	switch req.Op {
	case TalkOpCancel:
		t.cancelQueued()
	case TalkOpClear:
		t.clearNote()
	case TalkOpTake:
		text = t.takeReturned()
	case TalkOpSwitch:
		if !validConversation(req.Conversation) {
			return TalkOpResult{}, fmt.Errorf("unknown conversation %q", req.Conversation)
		}
		t.switchConversation(req.Conversation, req.Carry, req.Fresh)
	case TalkOpShow:
		if len(req.Turns) > maxKeptTurns {
			req.Turns = req.Turns[len(req.Turns)-maxKeptTurns:]
		}
		t.showConversation(req.Turns)
	case TalkOpLocal:
		t.addLocalLine(req.Text)
	case TalkOpStop:
		t.stopFollowing()
	case TalkOpReturn:
		t.returnWaiting(req.Conversation)
	case TalkOpReplay:
		t.replayStep(req.Key, req.You, req.Markdown, req.Turn, req.Final, cleanOrigin(req.Origin))
	case TalkOpLead:
		if len(req.Text) > maxLeadLength {
			return TalkOpResult{}, fmt.Errorf("the lead is too long")
		}
		t.update(func() bool {
			if t.lead == req.Text {
				return false
			}
			t.lead = req.Text
			return true
		})
	case TalkOpWindow:
		t.windowOpen(cleanOrigin(req.Origin), req.Open)
	default:
		return TalkOpResult{}, fmt.Errorf("unknown talk op %q", req.Op)
	}
	return TalkOpResult{Text: text, View: t.View()}, nil
}

// windowOpen: a page's talk window opened (and stays open) or folded. The developer looks: his line goes.
func (t *Talk) windowOpen(origin string, open bool) {
	if origin == "" {
		return
	}
	t.update(func() bool {
		if !open {
			delete(t.windows, origin)
			return false
		}
		t.windows[origin] = t.env.Now()
		if t.unseen == "" {
			return false
		}
		t.unseen = ""
		return true
	})
}

// clearNote: the developer writes again, and the note of a failed message goes. An answer still coming is not touched,
// nor a message waiting for him (#2284).
func (t *Talk) clearNote() {
	t.update(func() bool {
		if len(t.waiting) > 0 || t.stateOwner != "" || t.state.Phase == PhaseIdle {
			return false
		}
		t.state = IdleTalk
		return true
	})
}

func (t *Talk) giveBackLocked(w *TalkWaiting) {
	if before, ok := t.returned[w.Conversation]; ok {
		t.returned[w.Conversation] = before + "\n" + w.Text
		return
	}
	t.returned[w.Conversation] = w.Text
}

// restartWaitLocked: the waiting messages went or were given back, and a new wait starts for those left. Returns the
// drain to start, if any.
func (t *Talk) restartWaitLocked() func() {
	t.sendGen++
	if len(t.waiting) == 0 {
		if t.state.Phase == PhaseQueued {
			t.state = IdleTalk
		}
		return nil
	}
	gen := t.sendGen
	return func() { go t.drain(gen, false) }
}

// cancelQueued: the developer's Cancel on the waiting message of the conversation on screen; its text goes back to
// the field. A message waiting in the other conversation still goes (#2285).
func (t *Talk) cancelQueued() {
	var start func()
	t.update(func() bool {
		at := -1
		for i, w := range t.waiting {
			if w.Conversation == t.shown {
				at = i
				break
			}
		}
		if at < 0 {
			return false
		}
		mine := t.waiting[at]
		t.waiting = append(t.waiting[:at:at], t.waiting[at+1:]...)
		t.giveBackLocked(mine)
		start = t.restartWaitLocked()
		return true
	})
	if start != nil {
		start()
	}
}

// returnWaiting: the developer moved to another brainstorm (#2285); a message still waiting from the one left comes
// back to the field.
func (t *Talk) returnWaiting(key string) {
	var start func()
	t.update(func() bool {
		var kept []*TalkWaiting
		returned := false
		for _, w := range t.waiting {
			if w.Conversation == key {
				t.giveBackLocked(w)
				returned = true
				continue
			}
			kept = append(kept, w)
		}
		if !returned {
			return false
		}
		t.waiting = kept
		start = t.restartWaitLocked()
		return true
	})
	if start != nil {
		start()
	}
}

// takeReturned: a field took the text given back to the conversation on screen.
func (t *Talk) takeReturned() string {
	var text string
	t.update(func() bool {
		var ok bool
		text, ok = t.returned[t.shown]
		if !ok {
			return false
		}
		delete(t.returned, t.shown)
		return true
	})
	return text
}

// switchConversation: the window moves to another conversation (FR-BOSS-010 AC24, #2285); `key`'s comes back as it was
// left, or empty with fresh. carry names a message whose exchange moves with it (his answer that opened the brainstorm).
func (t *Talk) switchConversation(key string, carry string, fresh bool) {
	t.update(func() bool {
		current := t.shown
		if key == current {
			return false
		}
		var carried, rest []TalkEntry
		for _, entry := range t.convs[current] {
			if carry != "" && entry.Id == carry {
				carried = append(carried, entry)
				continue
			}
			rest = append(rest, entry)
		}
		if len(carried) > 0 {
			for _, tr := range append([]*tracked{t.tracked}, t.replayedLocked()...) {
				if tr != nil && tr.id == carry {
					tr.conversation = key
				}
			}
		}
		next := t.convs[key]
		if fresh {
			next = nil
		}
		t.convs[current] = append([]TalkEntry{}, rest...)
		t.convs[key] = capEntries(append(append([]TalkEntry{}, next...), carried...))
		t.shown = key
		t.unseen = ""
		return true
	})
}

func (t *Talk) replayedLocked() []*tracked {
	rtn := make([]*tracked, 0, len(t.replayed))
	for _, tr := range t.replayed {
		rtn = append(rtn, tr)
	}
	return rtn
}

// showConversation: the conversation of a brainstorm the developer moved to (#2248) takes the place of the one on screen,
// each line as it was kept, complete and offering nothing. A message of this conversation still answered stays after it.
func (t *Talk) showConversation(turns []KeptTurn) {
	t.update(func() bool {
		var entries []TalkEntry
		id := ""
		answered := map[string]bool{}
		for _, turn := range turns {
			switch turn.Role {
			case RoleYou:
				id = t.nextId("saved")
				entries = append(entries, TalkEntry{Id: id, Role: RoleYou, Text: turn.Text, At: turn.At})
			case RoleBrokk:
				answerId := id
				if answerId == "" || answered[answerId] {
					answerId = t.nextId("saved")
				}
				answered[answerId] = true
				entries = append(entries, TalkEntry{Id: answerId, Role: RoleBrokk, Markdown: turn.Text, At: turn.At, Final: true, Still: true})
			}
		}
		if live := t.tracked; live != nil && !live.stopped && live.conversation == t.shown {
			entries = append(entries, TalkEntry{Id: live.id, Role: RoleYou, Text: live.text, At: live.sentAt, Taken: true, Origin: live.origin})
			if live.markdown != "" {
				entries = append(entries, TalkEntry{Id: live.id, Role: RoleBrokk, Markdown: live.markdown, Turn: live.turn, At: t.nowMs(), Origin: live.origin})
			}
		}
		t.convs[t.shown] = capEntries(entries)
		t.unseen = ""
		return true
	})
}

// addLocalLine: a line of his that MoltenTerm says for him, with no message behind it (the brainstorm's opening, #2246).
func (t *Talk) addLocalLine(text string) {
	if text == "" || len(text) > maxLeadLength {
		return
	}
	t.update(func() bool {
		t.appendLocked(t.shown, TalkEntry{Id: t.nextId("local"), Role: RoleBrokk, Markdown: text, At: t.nowMs(), Final: true, Still: true})
		return true
	})
}

// stopFollowing: the developer moved to another brainstorm (#2248); the answer still coming belongs to the one left.
func (t *Talk) stopFollowing() {
	t.update(func() bool {
		if t.tracked == nil || t.tracked.stopped {
			return false
		}
		t.tracked.stopped = true
		return true
	})
}

// replayStep: the scripted replay of a brainstorm (dev and local builds, #2246): a message and what he answers to it
// so far, read the way a real answer is. Nothing reaches his session.
func (t *Talk) replayStep(key string, you string, markdown string, turn int, final bool, origin string) {
	if key == "" {
		return
	}
	t.update(func() bool {
		tr := t.replayed[key]
		if tr == nil {
			tr = &tracked{id: t.nextId("replay"), conversation: t.shown, origin: origin, text: you, sentAt: t.nowMs(), turn: turn, stopped: true}
			t.replayed[key] = tr
			t.appendLocked(tr.conversation, TalkEntry{Id: tr.id, Role: RoleYou, Text: you, At: t.nowMs(), Origin: origin})
		}
		t.keepAnswerLocked(tr, Reply{Status: ReplyAnswer, Markdown: markdown, Index: turn, At: t.nowMs()}, final)
		return true
	})
}

// Permit gives the developer's answer to the request on screen, for that request alone; a request that was over says
// so in every window.
func (t *Talk) Permit(req PermitRequest) PermitResult {
	status := PermitResult{Status: PermitGone}
	if t.env.Answer != nil {
		status = t.env.Answer(req)
	}
	t.update(func() bool {
		switch status.Status {
		case PermitAnswered:
			t.answeredAsks = append(t.answeredAsks, req.Id)
			if len(t.answeredAsks) > maxAnsweredAsks {
				t.answeredAsks = t.answeredAsks[len(t.answeredAsks)-maxAnsweredAsks:]
			}
			t.gone = false
			return true
		case PermitGone:
			// A request a window just answered is over for the others too, not answered elsewhere: a second window's
			// click right after it says nothing.
			if slices.Contains(t.answeredAsks, req.Id) {
				return false
			}
			t.gone = true
			return true
		}
		// An answer that was not valid leaves the request waiting as it was.
		return false
	})
	return status
}

// AsksChanged: his agent's request came or went (the broker's own news): every window shows it at once.
func (t *Talk) AsksChanged() {
	var ask *PermissionAsk
	if t.env.Pending != nil {
		ask = t.env.Pending()
	}
	t.update(func() bool {
		if ask != nil && ask.Id != t.lastAsk {
			t.lastAsk = ask.Id
			t.gone = false
		}
		return true
	})
}

func (t *Talk) keepApprovalsLocked(reply *Reply) bool {
	if reply == nil {
		return false
	}
	before := t.approved
	t.approved = recentApprovals(withApprovals(t.approved, reply.Approved), t.env.Now())
	return !slices.Equal(before, t.approved)
}

// recentApprovals keeps the approvals of the last autoApprovalKeep, at most maxAutoApprovals, as the broker does.
func recentApprovals(approved []AutoApproval, now time.Time) []AutoApproval {
	since := now.Add(-autoApprovalKeep).UnixMilli()
	rtn := make([]AutoApproval, 0, len(approved))
	for _, a := range approved {
		if a.At >= since {
			rtn = append(rtn, a)
		}
	}
	if len(rtn) > maxAutoApprovals {
		rtn = rtn[len(rtn)-maxAutoApprovals:]
	}
	return rtn
}

func (t *Talk) keepBlockLocked(blockId string) {
	if blockId != "" {
		t.blockId = blockId
	}
}

func (t *Talk) facts() TalkFacts {
	var blockId string
	t.read(func() { blockId = t.blockId })
	if blockId == "" || t.env.Facts == nil {
		return TalkFacts{}
	}
	return t.env.Facts(blockId)
}
