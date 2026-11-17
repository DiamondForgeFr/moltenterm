// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package logwatch is Brokk's internal log watch (FR-BOSS-012, DS-BOSS-013, #2336): on gold, dev and local builds only,
// wavesrv reads the new part of the app's log at start and every 10 minutes, groups what goes wrong by signature, and
// raises a calm card in Brokk's notes for a new panic or crash, a spike, or a log that grows too fast. From the card the
// developer asks an agent of MoltenTerm's repository to look (one hand-off, the log's text quoted as data), ignores that
// kind, or shows the log in its folder. Nothing is sent without that click.
package logwatch

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The answers of Ask (AskResult.Status); must match frontend/moltenterm-shell/logwatch/logwatch-model.ts.
const (
	AskSent = "sent"
	// AskPick: no lead of MoltenTerm's repository stands out; the developer picks among Agents.
	AskPick = "pick"
	// AskNoAgent: no local agent runs, so nobody can be asked.
	AskNoAgent = "noagent"
	// AskGone: the agent the developer picked no longer runs.
	AskGone = "gone"
	// AskUnknown: the watch no longer knows that card's signature.
	AskUnknown = "unknown"
)

// LookEvery: how often the watch looks at the log after its first look, at start (FR-BOSS-012 AC2).
const LookEvery = 10 * time.Minute

// ErrOff is what the commands answer where the watch does not run (a release, the switch off).
var ErrOff = uimsg.Errorf(uimsg.Make("logwatch.off"), "the log watch is off on this build")

// Env is what the watch needs from wavesrv; tests replace it.
type Env struct {
	DataDir  string
	Home     string
	Location *time.Location
	Now      func() time.Time
	// Enabled is the gate (buildchannel.LogWatchEnabled), read at each look and each command.
	Enabled func() bool
	Publish func(ctx context.Context, input molten.NotificationInput) error
	Agents  func(ctx context.Context) []Agent
	Locks   func() []molten.AgentNameLock
	// IsMoltenTerm: the project folder is MoltenTerm's own repository.
	IsMoltenTerm func(ctx context.Context, dir string) bool
	Send         func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error)
	Channel      string
	Version      string
	Logf         func(format string, args ...any)
}

// AskRequest is "Ask an agent to look" on a card: its signature, and the agent the developer picked when there was a
// choice.
type AskRequest struct {
	Id      string `json:"id"`
	BlockId string `json:"blockid,omitempty"`
}

type AskResult struct {
	Status string `json:"status"`
	// To: the first name of the agent asked; Delivery: delivered, typed or queued (agenthandoff).
	To       string      `json:"to,omitempty"`
	Delivery string      `json:"delivery,omitempty"`
	Agents   []Candidate `json:"agents,omitempty"`
}

type MuteRequest struct {
	Id string `json:"id"`
}

type Watcher struct {
	env Env

	lock   sync.Mutex
	state  State
	loaded bool
}

func MakeWatcher(env Env) *Watcher {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.Location == nil {
		env.Location = time.Local
	}
	if env.Logf == nil {
		env.Logf = func(string, ...any) {}
	}
	return &Watcher{env: env}
}

func (w *Watcher) logPath() string {
	return filepath.Join(w.env.DataDir, LogFileName)
}

func (w *Watcher) logsDir() string {
	return filepath.Join(w.env.DataDir, LogsDirName)
}

func (w *Watcher) statePath() string {
	return statePath(w.env.DataDir)
}

func (w *Watcher) loadLocked() {
	if !w.loaded {
		w.state = loadState(w.statePath())
		if w.state.Muted == nil {
			w.state.Muted = map[string]int64{}
		}
		w.loaded = true
	}
}

func (w *Watcher) saveLocked() {
	if err := saveState(w.statePath(), w.state); err != nil {
		w.env.Logf("%s the state could not be kept: %v\n", ownMark, err)
	}
}

func (w *Watcher) cardFacts(now time.Time) cardFacts {
	return cardFacts{logPath: w.logPath(), now: now, loc: w.env.Location}
}

func (w *Watcher) briefFacts(now time.Time) briefFacts {
	return briefFacts{logPath: w.logPath(), logsDir: w.logsDir(), channel: w.env.Channel, version: w.env.Version,
		home: w.env.Home, now: now, loc: w.env.Location}
}

// cardOf is the card an operation publishes, built from the state.
func (w *Watcher) cardOfLocked(op cardOp, now time.Time) (molten.NotificationInput, bool) {
	if op.id == GrowthId {
		return growthCard(w.state.Growth, w.cardFacts(now), !op.raise), true
	}
	i := w.state.find(op.id)
	if i < 0 {
		return molten.NotificationInput{}, false
	}
	return signatureCard(w.state.Signatures[i], w.cardFacts(now), !op.raise), true
}

// Look reads what the log gained since the last look and raises or refreshes the cards. It does nothing while the gate
// is shut: on a release, or with the switch off.
func (w *Watcher) Look(ctx context.Context) error {
	if !w.env.Enabled() {
		return nil
	}
	cards, err := w.look()
	w.publish(ctx, cards)
	return err
}

func (w *Watcher) look() ([]molten.NotificationInput, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.loadLocked()
	now := w.env.Now()
	out, mark, err := readNew(w.logPath(), w.logsDir(), w.state.File)
	if err != nil {
		return nil, fmt.Errorf("reading the log: %w", err)
	}
	w.state.File = mark
	var recs []Record
	for _, chunk := range out.chunks {
		recs = append(recs, recordsOf(entriesOf(chunk, w.env.Location), now, w.state.addBytes)...)
	}
	if out.skipped > 0 {
		w.state.addBytes(now, out.skipped)
	}
	facts := w.state.ingest(recs, w.env.Home)
	ops := w.state.decide(facts, now)
	w.state.prune(now)
	var cards []molten.NotificationInput
	for _, op := range ops {
		if card, ok := w.cardOfLocked(op, now); ok {
			cards = append(cards, card)
		}
	}
	w.saveLocked()
	return cards, nil
}

func (w *Watcher) publish(ctx context.Context, cards []molten.NotificationInput) {
	if w.env.Publish == nil {
		return
	}
	for _, card := range cards {
		if err := w.env.Publish(ctx, card); err != nil {
			w.env.Logf("%s a card could not be published: %v\n", ownMark, err)
		}
	}
}

// Run looks at once, then every interval, until ctx ends.
func (w *Watcher) Run(ctx context.Context, every time.Duration) {
	w.lookLogged(ctx)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.lookLogged(ctx)
		}
	}
}

func (w *Watcher) lookLogged(ctx context.Context) {
	if err := w.Look(ctx); err != nil {
		w.env.Logf("%s %v\n", ownMark, err)
	}
}

// Mute is "Ignore this kind": the signature (or the log's growth) raises no card and no update any more.
func (w *Watcher) Mute(ctx context.Context, req MuteRequest) error {
	if !w.env.Enabled() {
		return ErrOff
	}
	id := strings.TrimSpace(req.Id)
	if id == "" {
		return errors.New("which card's kind to ignore is missing")
	}
	w.lock.Lock()
	defer w.lock.Unlock()
	w.loadLocked()
	w.state.Muted[id] = w.env.Now().UnixMilli()
	w.state.prune(w.env.Now())
	w.saveLocked()
	return nil
}

// askTarget is what a request is about, read under the lock.
type askTarget struct {
	goal, context, closing string
}

func (w *Watcher) targetOf(id string) (askTarget, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.loadLocked()
	now := w.env.Now()
	if id == GrowthId {
		if w.state.Growth.Raised == 0 {
			return askTarget{}, false
		}
		goal, ctx, closing := growthBrief(w.state.Growth, w.state.busiest(now, busiestInGrowth), w.briefFacts(now))
		return askTarget{goal, ctx, closing}, true
	}
	i := w.state.find(id)
	if i < 0 {
		return askTarget{}, false
	}
	goal, ctx, closing := signatureBrief(w.state.Signatures[i], w.briefFacts(now))
	return askTarget{goal, ctx, closing}, true
}

// markAsked keeps who was asked, for the card, and answers the card brought up to date.
func (w *Watcher) markAsked(id string, name string) (molten.NotificationInput, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.loadLocked()
	if id == GrowthId {
		w.state.Growth.Asked = name
	} else if i := w.state.find(id); i >= 0 {
		w.state.Signatures[i].Asked = name
	} else {
		return molten.NotificationInput{}, false
	}
	w.saveLocked()
	return w.cardOfLocked(cardOp{id: id}, w.env.Now())
}

func (w *Watcher) agentsOf(ctx context.Context) []Agent {
	if w.env.Agents == nil {
		return nil
	}
	return w.env.Agents(ctx)
}

func (w *Watcher) isMoltenTerm(ctx context.Context) func(dir string) bool {
	return func(dir string) bool {
		return w.env.IsMoltenTerm != nil && w.env.IsMoltenTerm(ctx, dir)
	}
}

// Ask is "Ask an agent to look": one request to the lead of MoltenTerm's repository, or to the agent the developer
// picked; with no lead that stands out, it answers the agents to pick among and sends nothing.
func (w *Watcher) Ask(ctx context.Context, req AskRequest) (AskResult, error) {
	if !w.env.Enabled() {
		return AskResult{}, ErrOff
	}
	id := strings.TrimSpace(req.Id)
	target, ok := w.targetOf(id)
	if !ok {
		return AskResult{Status: AskUnknown}, nil
	}
	agents := w.agentsOf(ctx)
	var to *Agent
	if picked := strings.TrimSpace(req.BlockId); picked != "" {
		for i := range agents {
			if agents[i].BlockId == picked {
				to = &agents[i]
				break
			}
		}
		if to == nil {
			return AskResult{Status: AskGone}, nil
		}
	} else {
		var locks []molten.AgentNameLock
		if w.env.Locks != nil {
			locks = w.env.Locks()
		}
		var offer []Candidate
		to, offer = chooseRecipient(agents, locks, w.isMoltenTerm(ctx))
		if to == nil {
			if len(offer) == 0 {
				return AskResult{Status: AskNoAgent}, nil
			}
			return AskResult{Status: AskPick, Agents: offer}, nil
		}
	}
	sent, err := w.env.Send(ctx, agenthandoff.AppRequest{ToBlockId: to.BlockId, Goal: target.goal, Context: target.context,
		Closing: target.closing, Key: CardKeyPrefix + id})
	if err != nil {
		return AskResult{}, uimsg.Errorf(uimsg.Make("logwatch.sendFailed", "detail", err.Error()), "the request could not be sent: %v", err)
	}
	name := sent.To
	if name == "" {
		name = to.FirstName
	}
	if card, ok := w.markAsked(id, name); ok {
		w.publish(ctx, []molten.NotificationInput{card})
	}
	return AskResult{Status: AskSent, To: name, Delivery: sent.Status}, nil
}
