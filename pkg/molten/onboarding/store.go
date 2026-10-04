// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const NotificationSource = "moltenterm"

var skipAtStart bool

// The variable is read before main runs: wavesrv captures its environment for local shells early in its startup, and
// a terminal of a test instance must not hand the skip to an instance started from it without saying so.
func init() {
	skipAtStart = SkipRequested(os.Getenv(SkipVarName))
	os.Unsetenv(SkipVarName)
}

// SkipRequestedAtStart tells whether wavesrv was started with MOLTENTERM_SKIP_ONBOARDING.
func SkipRequestedAtStart() bool {
	return skipAtStart
}

// One writer of the record at a time: windows, the start and closed panels all read, decide and write under it.
var stateLock sync.Mutex

func withStateLock[T any](fn func() (T, error)) (T, error) {
	stateLock.Lock()
	defer stateLock.Unlock()
	return fn()
}

// PanelLocation is where a workspace's first-run panel is.
type PanelLocation struct {
	TabId   string `json:"tabid,omitempty"`
	BlockId string `json:"blockid,omitempty"`
}

func isPanel(block *waveobj.Block) bool {
	return block != nil && block.Meta.GetString(waveobj.MetaKey_View, "") == ViewType
}

// HasPanelBlocks tells whether any first-run panel exists, in any workspace.
func HasPanelBlocks(blocks []*waveobj.Block) bool {
	for _, block := range blocks {
		if isPanel(block) {
			return true
		}
	}
	return false
}

func hasAnyPanel(ctx context.Context) (bool, error) {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return false, fmt.Errorf("reading the blocks: %w", err)
	}
	return HasPanelBlocks(blocks), nil
}

// FindPanel returns the first-run panel of a workspace, active tab first; an empty location when it has none.
func FindPanel(ctx context.Context, workspaceId string) (PanelLocation, error) {
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		return PanelLocation{}, err
	}
	if ws == nil {
		return PanelLocation{}, nil
	}
	tabIds := make([]string, 0, len(ws.TabIds)+1)
	if ws.ActiveTabId != "" {
		tabIds = append(tabIds, ws.ActiveTabId)
	}
	for _, tabId := range ws.TabIds {
		if tabId != ws.ActiveTabId {
			tabIds = append(tabIds, tabId)
		}
	}
	for _, tabId := range tabIds {
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if tab == nil {
			continue
		}
		for _, blockId := range tab.BlockIds {
			block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
			if isPanel(block) {
				return PanelLocation{TabId: tabId, BlockId: blockId}, nil
			}
		}
	}
	return PanelLocation{}, nil
}

func writeOutcome(ctx context.Context, client *waveobj.Client, outcome Outcome, nowMs int64) error {
	setTos := outcome.SetTos && client.TosAgreed == 0
	if !outcome.Write && !setTos {
		return nil
	}
	if outcome.Write {
		if client.Meta == nil {
			client.Meta = make(waveobj.MetaMapType)
		}
		client.Meta[MetaKey] = MetaValue(outcome.State)
	}
	if setTos {
		client.TosAgreed = nowMs
	}
	return wstore.DBUpdate(ctx, client)
}

type decideFn func(ctx context.Context, client *waveobj.Client, state State, hasState bool, nowMs int64) (Outcome, error)

// decideAndWrite reads the client and writes the outcome in one transaction, under the state lock, then tells the
// windows and publishes the notification the outcome announces.
func decideAndWrite(ctx context.Context, decide decideFn) (Outcome, error) {
	outcome, err := withStateLock(func() (Outcome, error) {
		var outcome Outcome
		err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			client, err := wstore.DBGetSingleton[*waveobj.Client](tctx)
			if err != nil {
				return fmt.Errorf("reading the client: %w", err)
			}
			nowMs := time.Now().UnixMilli()
			state, hasState := ReadState(client.Meta)
			outcome, err = decide(tctx, client, state, hasState, nowMs)
			if err != nil {
				return err
			}
			return writeOutcome(tctx, client, outcome, nowMs)
		})
		return outcome, err
	})
	if err != nil {
		return Outcome{}, err
	}
	if outcome.Write || outcome.SetTos {
		publishClientUpdate(ctx)
	}
	announce(ctx, outcome.Announce)
	return outcome, nil
}

// StartFirstRun applies the start rules (DecideStart) when wavesrv starts, before any window loads; the caller
// applies the layout of the outcome to the first tab.
func StartFirstRun(ctx context.Context, firstTabEmpty bool) (Outcome, error) {
	return decideAndWrite(ctx, func(ctx context.Context, client *waveobj.Client, state State, hasState bool, nowMs int64) (Outcome, error) {
		facts := StartFacts{
			Skip:          skipAtStart,
			HasState:      hasState,
			State:         state,
			TosAgreed:     client.TosAgreed != 0,
			FirstTabEmpty: firstTabEmpty,
		}
		if hasState && !state.Done {
			hasPanel, err := hasAnyPanel(ctx)
			if err != nil {
				return Outcome{}, err
			}
			facts.HasPanel = hasPanel
		}
		return DecideStart(facts, nowMs, wavebase.WaveVersion), nil
	})
}

// ApplyWindowUpdate applies an update sent by a window and returns the state it leads to.
func ApplyWindowUpdate(ctx context.Context, update Update) (State, error) {
	outcome, err := decideAndWrite(ctx, func(ctx context.Context, client *waveobj.Client, state State, hasState bool, nowMs int64) (Outcome, error) {
		return ApplyUpdate(state, hasState, client.TosAgreed != 0, update, nowMs, wavebase.WaveVersion)
	})
	return outcome.State, err
}

// CheckPanelClosed records a run left by closing its last panel (rule 4 while MoltenTerm runs).
func CheckPanelClosed(ctx context.Context) error {
	_, err := decideAndWrite(ctx, func(ctx context.Context, client *waveobj.Client, state State, hasState bool, nowMs int64) (Outcome, error) {
		if !hasState || state.Done {
			return Outcome{}, nil
		}
		hasPanel, err := hasAnyPanel(ctx)
		if err != nil {
			return Outcome{}, err
		}
		return DecideClosed(state, hasState, client.TosAgreed != 0, hasPanel, nowMs, wavebase.WaveVersion), nil
	})
	return err
}

// CurrentState reads the record; ok is false before wavesrv wrote one.
func CurrentState(ctx context.Context) (State, bool, error) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return State{}, false, fmt.Errorf("reading the client: %w", err)
	}
	state, ok := ReadState(client.Meta)
	return state, ok, nil
}

func openAction() molten.NotificationAction {
	return molten.NotificationAction{Id: "open", Label: "Open Getting started", Kind: "gesture", Gesture: OpenGesture, Lasting: true}
}

// NotificationFor is what the notification center says after a start or a leave; ok is false when nothing is said.
func NotificationFor(announce string) (molten.NotificationInput, bool) {
	switch announce {
	case AnnounceAvailable:
		return molten.NotificationInput{
			Key:     NotificationKey,
			Source:  NotificationSource,
			Kind:    "info",
			Title:   "Getting started is available",
			Message: "A short setup: your agent, a first morph, your project. It is also in the app menu and the command palette.",
			Actions: []molten.NotificationAction{openAction()},
		}, true
	case AnnounceLeft:
		return molten.NotificationInput{
			Key:     NotificationKey,
			Source:  NotificationSource,
			Kind:    "info",
			Title:   "Getting started is still here",
			Message: "Open it again whenever you want, from the app menu or the command palette.",
			Actions: []molten.NotificationAction{openAction()},
		}, true
	}
	return molten.NotificationInput{}, false
}

func announce(ctx context.Context, what string) {
	input, ok := NotificationFor(what)
	if !ok {
		return
	}
	if err := attention.PublishNotification(ctx, input); err != nil {
		log.Printf("molten: first run notification: %v\n", err)
	}
}

// The same update event as wcore.SendWaveObjUpdate, which this package cannot import (wcore starts the first run).
func publishClientUpdate(ctx context.Context) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		log.Printf("molten: reading the client for its update event: %v\n", err)
		return
	}
	oref := waveobj.MakeORef(waveobj.OType_Client, client.OID)
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_WaveObjUpdate,
		Scopes: []string{oref.String()},
		Data: waveobj.WaveObjUpdate{
			UpdateType: waveobj.UpdateType_Update,
			OType:      client.GetOType(),
			OID:        client.OID,
			Obj:        client,
		},
	})
}
