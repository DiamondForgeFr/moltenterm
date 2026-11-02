// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The setup's agent board (FR-MC-045, #1163): the coding agent in the pipeline tab's terminal proposes changes, flags
// points to check and highlights the step it explains, through `molten pipeline setup`; the setup panel shows them
// live and the developer decides each one there. It is a use of morph (#718): an agent changes MoltenTerm's interface
// through the molten commands, and everything it adds can be declined and is gone once the setup closes. The board
// lives in memory only and never writes a file: an accepted change joins the draft, which the setup's pull request
// writes (#1098).

const (
	BoardItemChange = "change"
	BoardItemFlag   = "flag"

	BoardStateOpen      = "open"
	BoardStateAccepted  = "accepted"
	BoardStateDeclined  = "declined"
	BoardStateWithdrawn = "withdrawn"
	// A flag the developer keeps: its proposed answer is noted, the draft does not change.
	BoardStateKept = "kept"

	// The marks the preview gives a proposed step, read by the panel's sentences and diagram.
	BoardMarkAdd    = "add"
	BoardMarkChange = "change"
	BoardMarkRemove = "remove"

	maxBoardItems   = 60
	maxBoardText    = 400
	maxBoardSteps   = 80
	maxBoardScreen  = 40
	maxBoardContext = maxPipelineBytes
)

var boardScreenRe = regexp.MustCompile(`^[a-z0-9-]*$`)

// BoardWhos: who does a step, as the panel's chips say it (mc.setup.plain.who.<value>).
var BoardWhos = map[string]bool{"molten": true, "you": true, "confirm": true, "approve": true, "validate": true}

// BoardStep is one plain-words step as the panel shows it: its channel, its number and the pipeline steps it tells.
type BoardStep struct {
	Channel string   `json:"channel"`
	N       int      `json:"n"`
	Ids     []string `json:"ids"`
	Text    string   `json:"text"`
}

// BoardContext is what the window publishes while the setup is open: the screen, the draft as the panel holds it
// (with the accepted changes), and the steps it tells.
type BoardContext struct {
	Dir    string      `json:"dir"`
	Screen string      `json:"screen"`
	Text   string      `json:"text"`
	Steps  []BoardStep `json:"steps"`
}

// BoardItem is one proposal of the agent: a change in #1099's contract, or a point to check with its proposed answer.
type BoardItem struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	State string `json:"state"`
	// The agent's first name, "" when its terminal has none.
	By     string      `json:"by,omitempty"`
	At     int64       `json:"at"`
	Change *StepChange `json:"change,omitempty"`
	// The agent's one-line reason, in its own words.
	Why string `json:"why,omitempty"`
	// An added or changed step as the panel should read it: the agent's sentence and who does it (#1163).
	Say string `json:"say,omitempty"`
	Who string `json:"who,omitempty"`
	// The item this one was copied from, for "apply to the other channel too".
	From string `json:"from,omitempty"`
	// A flag's step ("rc/tag"), its point and its proposed answer, in the agent's words.
	Step   string `json:"step,omitempty"`
	Point  string `json:"point,omitempty"`
	Answer string `json:"answer,omitempty"`
}

// BoardExplain is the step the agent is explaining.
type BoardExplain struct {
	Channel string   `json:"channel"`
	N       int      `json:"n"`
	Ids     []string `json:"ids"`
	// The agent's words beside the highlight.
	Note string `json:"note,omitempty"`
	By   string `json:"by,omitempty"`
	At   int64  `json:"at"`
}

type BoardMark struct {
	Key string `json:"key"`
	Op  string `json:"op"`
}

// BoardState is what the panel and `molten pipeline setup show` read.
type BoardState struct {
	Dir     string        `json:"dir"`
	Open    bool          `json:"open"`
	Screen  string        `json:"screen,omitempty"`
	Steps   []BoardStep   `json:"steps"`
	Items   []BoardItem   `json:"items"`
	Explain *BoardExplain `json:"explain,omitempty"`
	// The draft with the open changes in place (added and changed steps), for the panel's marks; removals stay and are
	// marked. Marks are by "channel/id".
	Preview string `json:"preview,omitempty"`
	// The draft the proposals are checked against (the panel's, with the accepted changes): the "before" of a change.
	Base  string               `json:"base,omitempty"`
	Marks map[string]BoardMark `json:"marks,omitempty"`
	Seq   int                  `json:"seq"`
}

// BoardRefusal is an agent's request the board does not take, with why, in English: the agent reads it.
type BoardRefusal struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

func (r *BoardRefusal) Error() string {
	if r.Detail == "" {
		return "not taken (" + r.Code + ")"
	}
	return "not taken (" + r.Code + "): " + r.Detail
}

type boardEntry struct {
	ctx     BoardContext
	items   []BoardItem
	explain *BoardExplain
	next    int
	seq     int
}

// Board holds the open setups' boards, by project folder.
type Board struct {
	// Publish tells the windows a board changed; nil in the tests that do not need it.
	Publish func(state BoardState)
	// Now is the clock, replaced in the tests.
	Now func() time.Time

	lock    sync.Mutex
	entries map[string]*boardEntry
}

func MakeBoard(publish func(state BoardState)) *Board {
	return &Board{Publish: publish, Now: time.Now, entries: map[string]*boardEntry{}}
}

func boardKey(dir string) (string, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return "", fmt.Errorf("not an absolute folder: %q", dir)
	}
	return filepath.Clean(dir), nil
}

func clip(text string, max int) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

func checkContext(c BoardContext) error {
	if len(c.Text) > maxBoardContext {
		return fmt.Errorf("the draft is too large")
	}
	if len(c.Screen) > maxBoardScreen || !boardScreenRe.MatchString(c.Screen) {
		return fmt.Errorf("unknown screen %q", c.Screen)
	}
	if len(c.Steps) > maxBoardSteps {
		return fmt.Errorf("too many steps")
	}
	for _, s := range c.Steps {
		if s.Channel != ChannelRc && s.Channel != ChannelPublic {
			return fmt.Errorf("channel %q is neither rc nor public", s.Channel)
		}
	}
	return nil
}

// Open publishes the window's context: the board opens on the first call and follows the panel on the next ones.
func (b *Board) Open(c BoardContext) (BoardState, error) {
	key, err := boardKey(c.Dir)
	if err != nil {
		return BoardState{}, err
	}
	if err := checkContext(c); err != nil {
		return BoardState{}, err
	}
	c.Dir = key
	for i := range c.Steps {
		c.Steps[i].Text = clip(c.Steps[i].Text, maxBoardText)
	}
	return b.change(key, true, func(e *boardEntry) error {
		e.ctx = c
		return nil
	})
}

// Close drops the board: nothing the agent proposed remains once the setup closes (#719's reversibility rule).
func (b *Board) Close(dir string) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	b.lock.Lock()
	delete(b.entries, key)
	b.lock.Unlock()
	state := BoardState{Dir: key, Steps: []BoardStep{}, Items: []BoardItem{}}
	b.publish(state)
	return state, nil
}

// State reads a board; a closed one says so.
func (b *Board) State(dir string) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	e := b.entries[key]
	if e == nil {
		return BoardState{Dir: key, Steps: []BoardStep{}, Items: []BoardItem{}}, nil
	}
	return stateOf(key, e), nil
}

func (b *Board) publish(state BoardState) {
	if b.Publish != nil {
		b.Publish(state)
	}
}

// change runs fn on the folder's board under the lock and publishes the result. open: a missing board is made (the
// window); otherwise a missing board is refused (the agent: no setup is open).
func (b *Board) change(key string, open bool, fn func(e *boardEntry) error) (BoardState, error) {
	b.lock.Lock()
	e := b.entries[key]
	if e == nil {
		if !open {
			b.lock.Unlock()
			return BoardState{}, &BoardRefusal{Code: "notopen", Detail: "the pipeline setup of this project is not open in MoltenTerm: ask the developer to open it (Release menu, pipeline setup)"}
		}
		e = &boardEntry{ctx: BoardContext{Dir: key}}
		b.entries[key] = e
	}
	if err := fn(e); err != nil {
		b.lock.Unlock()
		return BoardState{}, err
	}
	e.seq++
	state := stateOf(key, e)
	b.lock.Unlock()
	b.publish(state)
	return state, nil
}

func (b *Board) now() int64 {
	if b.Now == nil {
		return time.Now().UnixMilli()
	}
	return b.Now().UnixMilli()
}

func openItems(e *boardEntry) int {
	n := 0
	for _, it := range e.items {
		if it.State == BoardStateOpen {
			n++
		}
	}
	return n
}

func (e *boardEntry) add(it BoardItem) error {
	if openItems(e) >= maxBoardItems {
		return &BoardRefusal{Code: "toomany", Detail: fmt.Sprintf("%d proposals are already open: withdraw some, or wait for the developer to decide", maxBoardItems)}
	}
	e.next++
	it.Key = strconv.Itoa(e.next)
	it.State = BoardStateOpen
	e.items = append(e.items, it)
	return nil
}

// Propose takes one change in #1099's contract, checked against the panel's draft with FR-MC-039's rules; a change
// MoltenTerm would not offer is refused with its reason and never reaches the panel.
func (b *Board) Propose(dir string, by string, raw json.RawMessage, why string) (BoardItem, error) {
	return b.ProposeSaid(dir, by, raw, why, "", "")
}

// ProposeSaid is Propose with the step as the panel should read it once changed: the agent's sentence in plain words
// (say) and who does it (who, one of the panel's who values). Both are optional; without them the panel tells the
// step from the pipeline model.
func (b *Board) ProposeSaid(dir string, by string, raw json.RawMessage, why string, say string, who string) (BoardItem, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardItem{}, err
	}
	say, who = clip(say, maxBoardText), strings.TrimSpace(who)
	if who != "" && !BoardWhos[who] {
		return BoardItem{}, &BoardRefusal{Code: "who", Detail: fmt.Sprintf("--who is one of molten, you, confirm, approve, validate, not %q", who)}
	}
	raws, err := proposedRaws(raw)
	if err != nil {
		return BoardItem{}, err
	}
	var added BoardItem
	_, err = b.change(key, false, func(e *boardEntry) error {
		if strings.TrimSpace(e.ctx.Text) == "" {
			return &BoardRefusal{Code: "nodraft", Detail: "the setup has no draft yet: wait for the developer's screen to show the pipeline"}
		}
		offered, rejected, cerr := CheckChanges(key, []byte(e.ctx.Text), raws)
		if cerr != nil {
			return cerr
		}
		if len(rejected) > 0 {
			return &BoardRefusal{Code: rejected[0].Code, Detail: rejected[0].Detail}
		}
		c := offered[0]
		if strings.TrimSpace(why) != "" {
			c.Why = why
		}
		c.Why = clip(c.Why, maxBoardText)
		why = c.Why
		if why == "" {
			return &BoardRefusal{Code: "nowhy", Detail: "say why in one line, in plain words (--why)"}
		}
		if target := c.Channel + "/" + c.Id; c.Op != ChangeOpVersions && openTarget(e, target) {
			return &BoardRefusal{Code: RejectConflict, Detail: target + " already has an open proposal: withdraw it first"}
		}
		if c.Op == ChangeOpRemove || c.Op == ChangeOpVersions {
			say, who = "", ""
		}
		if err := e.add(BoardItem{Kind: BoardItemChange, By: by, At: b.now(), Change: &c, Why: why, Say: say, Who: who}); err != nil {
			return err
		}
		c.Key = e.items[len(e.items)-1].Key
		e.items[len(e.items)-1].Change = &c
		added = e.items[len(e.items)-1]
		return nil
	})
	return added, err
}

// proposedRaws reads one change: the change object itself, or #1099's answer ({"changes": [...]} or a list) holding
// exactly one.
func proposedRaws(raw json.RawMessage) ([]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		if _, ok := obj["op"]; ok {
			return []json.RawMessage{raw}, nil
		}
	}
	raws, err := ParseChanges(raw)
	if err != nil {
		code := RejectMalformed
		if err == errWholeFile {
			code = RejectOutside
		}
		return nil, &BoardRefusal{Code: code, Detail: err.Error()}
	}
	if len(raws) != 1 {
		return nil, &BoardRefusal{Code: RejectMalformed, Detail: "propose one change at a time"}
	}
	return raws, nil
}

func openTarget(e *boardEntry, target string) bool {
	for _, it := range e.items {
		if it.State == BoardStateOpen && it.Change != nil && it.Change.Channel+"/"+it.Change.Id == target {
			return true
		}
	}
	return false
}

// resolveStep reads "rc/3" (the plain-words number) or "rc/<step id>" against the panel's steps.
func resolveStep(steps []BoardStep, ref string) (BoardStep, error) {
	channel, rest, ok := strings.Cut(strings.TrimSpace(ref), "/")
	if !ok || (channel != ChannelRc && channel != ChannelPublic) || rest == "" {
		return BoardStep{}, &BoardRefusal{Code: "step", Detail: fmt.Sprintf("%q is not a step: write rc/<number> or public/<number> (see show)", ref)}
	}
	n, numErr := strconv.Atoi(rest)
	for _, s := range steps {
		if s.Channel != channel {
			continue
		}
		if numErr == nil && s.N == n {
			return s, nil
		}
		for _, id := range s.Ids {
			if numErr != nil && id == rest {
				return s, nil
			}
		}
	}
	return BoardStep{}, &BoardRefusal{Code: "step", Detail: fmt.Sprintf("the panel shows no step %s (see show)", ref)}
}

// Flag adds a point to check, on a step or on the whole setup, with the agent's proposed answer.
func (b *Board) Flag(dir string, by string, step string, point string, answer string) (BoardItem, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardItem{}, err
	}
	point, answer = clip(point, maxBoardText), clip(answer, maxBoardText)
	if point == "" {
		return BoardItem{}, &BoardRefusal{Code: "nopoint", Detail: "say the point to check"}
	}
	var added BoardItem
	_, err = b.change(key, false, func(e *boardEntry) error {
		ref := ""
		if strings.TrimSpace(step) != "" {
			s, serr := resolveStep(e.ctx.Steps, step)
			if serr != nil {
				return serr
			}
			// By the step's id: the numbers move when a step is added before it.
			ref = s.Channel + "/" + s.Ids[0]
		}
		if err := e.add(BoardItem{Kind: BoardItemFlag, By: by, At: b.now(), Step: ref, Point: point, Answer: answer}); err != nil {
			return err
		}
		added = e.items[len(e.items)-1]
		return nil
	})
	return added, err
}

// Explain highlights a step while the agent talks about it; an empty step clears the highlight.
func (b *Board) Explain(dir string, by string, step string, note string) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	return b.change(key, false, func(e *boardEntry) error {
		if strings.TrimSpace(step) == "" {
			e.explain = nil
			return nil
		}
		s, serr := resolveStep(e.ctx.Steps, step)
		if serr != nil {
			return serr
		}
		e.explain = &BoardExplain{Channel: s.Channel, N: s.N, Ids: s.Ids, Note: clip(note, maxBoardText), By: by, At: b.now()}
		return nil
	})
}

// Withdraw takes back one of the agent's open proposals or flags.
func (b *Board) Withdraw(dir string, itemKey string) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	return b.change(key, false, func(e *boardEntry) error {
		it := e.item(itemKey)
		if it == nil {
			return &BoardRefusal{Code: "noitem", Detail: fmt.Sprintf("no proposal %q (see show)", itemKey)}
		}
		if it.State != BoardStateOpen {
			return &BoardRefusal{Code: "decided", Detail: fmt.Sprintf("proposal %s is already %s", itemKey, it.State)}
		}
		it.State = BoardStateWithdrawn
		return nil
	})
}

func (e *boardEntry) item(key string) *BoardItem {
	for i := range e.items {
		if e.items[i].Key == key {
			return &e.items[i]
		}
	}
	return nil
}

// Decide is the developer's click in the panel: accept or decline a change, keep or dismiss a flag. An accepted change
// must still apply on the panel's draft. An accepted change can be declined later (the developer changed their mind).
func (b *Board) Decide(dir string, itemKey string, accept bool) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	return b.change(key, false, func(e *boardEntry) error {
		it := e.item(itemKey)
		if it == nil || it.State == BoardStateWithdrawn {
			return uimsg.Errorf(uimsg.Make("mission.setup.boardGone"), "this proposal was withdrawn")
		}
		if !accept {
			it.State = BoardStateDeclined
			return nil
		}
		if it.Kind == BoardItemFlag {
			it.State = BoardStateKept
			return nil
		}
		if it.State == BoardStateAccepted {
			return nil
		}
		if _, rejected, cerr := CheckChanges(key, []byte(e.ctx.Text), []json.RawMessage{rawOf(*it.Change)}); cerr != nil || len(rejected) > 0 {
			detail := ""
			if len(rejected) > 0 {
				detail = rejected[0].Code
			}
			return uimsg.Errorf(uimsg.Make("mission.setup.boardStale"), "this proposal no longer applies to the draft (%s)", detail)
		}
		it.State = BoardStateAccepted
		return nil
	})
}

func rawOf(c StepChange) json.RawMessage {
	raw, _ := json.Marshal(agentChange{Op: c.Op, Channel: c.Channel, Id: c.Id, After: c.After, Before: c.Before,
		Step: mustStep(c.Step), Versions: c.Versions, Why: c.Why})
	return raw
}

// BoardApplyAnswer is the base draft with the accepted changes, in the order they were accepted; Skipped lists the
// accepted changes that no longer apply to that base.
type BoardApplyAnswer struct {
	ApplyAnswer
	Applied []string `json:"applied"`
	Skipped []string `json:"skipped"`
}

// Apply puts the accepted changes on the panel's base draft (the draft before any agent change): they survive the
// developer going back or changing a choice. Nothing is written.
func (b *Board) Apply(dir string, base string) (BoardApplyAnswer, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardApplyAnswer{}, err
	}
	if err := checkDraftText(base); err != nil {
		return BoardApplyAnswer{}, err
	}
	b.lock.Lock()
	var accepted []StepChange
	if e := b.entries[key]; e != nil {
		for _, it := range e.items {
			if it.State == BoardStateAccepted && it.Change != nil {
				accepted = append(accepted, *it.Change)
			}
		}
	}
	b.lock.Unlock()
	text := []byte(base)
	answer := BoardApplyAnswer{Applied: []string{}, Skipped: []string{}}
	for _, c := range accepted {
		offered, rejected, cerr := CheckChanges(key, text, []json.RawMessage{rawOf(c)})
		if cerr != nil || len(rejected) > 0 || len(offered) != 1 {
			answer.Skipped = append(answer.Skipped, c.Key)
			continue
		}
		next, aerr := applyChanges(text, offered)
		if aerr != nil {
			answer.Skipped = append(answer.Skipped, c.Key)
			continue
		}
		text = next
		answer.Applied = append(answer.Applied, c.Key)
	}
	report := molten.ValidatePipelineData(key, text)
	answer.Proposed, answer.Errors, answer.ValidateWarnings = string(text), report.Errors, report.Warnings
	return answer, nil
}

func stateOf(key string, e *boardEntry) BoardState {
	state := BoardState{Dir: key, Open: true, Screen: e.ctx.Screen, Steps: append([]BoardStep{}, e.ctx.Steps...),
		Items: append([]BoardItem{}, e.items...), Seq: e.seq}
	if e.explain != nil {
		ex := *e.explain
		state.Explain = &ex
	}
	state.Preview, state.Marks = previewOf(e)
	state.Base = e.ctx.Text
	return state
}

// OtherChannel is the release channel that is not channel.
func OtherChannel(channel string) string {
	if channel == ChannelRc {
		return ChannelPublic
	}
	return ChannelRc
}

// CopyTo is the panel's "apply to the other channel too": the open step change itemKey, proposed again for the same
// step of the other channel, checked like any proposal. The copy is the agent's proposal still: it keeps its name,
// reason and words.
func (b *Board) CopyTo(dir string, itemKey string) (BoardState, error) {
	key, err := boardKey(dir)
	if err != nil {
		return BoardState{}, err
	}
	return b.change(key, false, func(e *boardEntry) error {
		it := e.item(itemKey)
		if it == nil || it.State != BoardStateOpen || it.Change == nil || it.Change.Op == ChangeOpVersions {
			return uimsg.Errorf(uimsg.Make("mission.setup.boardGone"), "this proposal was withdrawn")
		}
		c := *it.Change
		c.Channel = OtherChannel(c.Channel)
		if openTarget(e, c.Channel+"/"+c.Id) {
			return uimsg.Errorf(uimsg.Make("mission.setup.boardCopied"), "the other channel already has this proposal")
		}
		offered, rejected, cerr := CheckChanges(key, []byte(e.ctx.Text), []json.RawMessage{rawOf(c)})
		if cerr != nil || len(rejected) > 0 || len(offered) != 1 {
			detail := ""
			if len(rejected) > 0 {
				detail = rejected[0].Code
			}
			return uimsg.Errorf(uimsg.Make("mission.setup.boardStale"), "this proposal does not apply to the other channel (%s)", detail)
		}
		copied := offered[0]
		copied.Why = it.Why
		if err := e.add(BoardItem{Kind: BoardItemChange, By: it.By, At: b.now(), Change: &copied, Why: it.Why, Say: it.Say, Who: it.Who, From: it.Key}); err != nil {
			return err
		}
		copied.Key = e.items[len(e.items)-1].Key
		e.items[len(e.items)-1].Change = &copied
		return nil
	})
}

// previewOf applies the open additions and changes to the panel's draft one by one (a change that no longer applies is
// left out) and marks every open change's step.
func previewOf(e *boardEntry) (string, map[string]BoardMark) {
	marks := map[string]BoardMark{}
	text := []byte(e.ctx.Text)
	if len(text) == 0 {
		return "", marks
	}
	items := append([]BoardItem{}, e.items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].At < items[j].At })
	for _, it := range items {
		if it.State != BoardStateOpen || it.Change == nil || it.Change.Op == ChangeOpVersions {
			continue
		}
		c := *it.Change
		target := c.Channel + "/" + c.Id
		if c.Op == ChangeOpRemove {
			marks[target] = BoardMark{Key: it.Key, Op: BoardMarkRemove}
			continue
		}
		next, err := applyChanges(text, []StepChange{c})
		if err != nil {
			continue
		}
		text = next
		op := BoardMarkChange
		if c.Op == ChangeOpAdd {
			op = BoardMarkAdd
		}
		marks[target] = BoardMark{Key: it.Key, Op: op}
	}
	return string(text), marks
}
