// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-BOSS-009, AC26 (#2033): Brokk's own session is no agent of a workspace. The states the windows get say it is his, so
// that no list shows it; the ring on his face still reads its state.
func TestAgentStatesSayWhichBlockIsBrokks(t *testing.T) {
	h := makeAgentHarness()
	h.states.ownBlock = func(blockId string) bool { return blockId == "brokk" }
	h.out("brokk", cmdMark("claude"))
	h.out("b1", cmdMark("claude"))
	h.states.flush()

	own := map[string]bool{}
	for _, info := range h.published {
		own[info.BlockId] = info.Own
	}
	if !own["brokk"] || own["b1"] {
		t.Errorf("published own flags %v, want Brokk's session flagged and the developer's agent not", own)
	}
	snapshot := map[string]bool{}
	for _, info := range h.states.snapshot() {
		snapshot[info.BlockId] = info.Own
	}
	if !snapshot["brokk"] || snapshot["b1"] {
		t.Errorf("snapshot own flags %v, want the same, for a window that starts later", snapshot)
	}
}

func TestAgentStatesKeepTheStateOfBrokksSessionForHisFace(t *testing.T) {
	h := makeAgentHarness()
	h.states.ownBlock = func(blockId string) bool { return blockId == "brokk" }
	h.out("brokk", cmdMark("claude"))
	if err := h.report("brokk", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.states.flush()
	if got := h.state("brokk"); got != molten.AgentStateWorking {
		t.Errorf("state %q, want working: the ring on his face reads it", got)
	}
	last := h.published[len(h.published)-1]
	if !last.Own || last.State != molten.AgentStateWorking {
		t.Errorf("last event %+v, want his state, flagged", last)
	}
}

// Notices go through recordAgentNotice, whether a hook or the terminal's own signal raised them.
func TestNoNoticeIsRaisedForBrokksSession(t *testing.T) {
	var lock sync.Mutex
	var written []string
	oldOwn, oldWrite := isOwnBlock, writeNotice
	defer func() { isOwnBlock, writeNotice = oldOwn, oldWrite }()
	isOwnBlock = func(blockId string) bool { return blockId == "brokk" }
	writeNotice = func(_ context.Context, blockId string, signal AttentionSignal, kind string, _ time.Time) error {
		lock.Lock()
		defer lock.Unlock()
		written = append(written, blockId+":"+kind+":"+signal.TitleCode)
		return nil
	}

	done := AttentionSignal{Title: "Fanny is done", TitleCode: molten.NotificationTitleAgentDone, TitleName: "Fanny"}
	waiting := AttentionSignal{Title: "Fanny is waiting for you", TitleCode: molten.NotificationTitleAgentWaiting, TitleName: "Fanny"}
	recordAgentNotice("brokk", done, "success")
	recordAgentNotice("brokk", waiting, "warning")
	if len(written) != 0 {
		t.Fatalf("written for Brokk's session: %v, want no notice, so no toast and no row", written)
	}
	recordAgentNotice("b1", done, "success")
	if len(written) != 1 || written[0] != "b1:success:"+molten.NotificationTitleAgentDone {
		t.Errorf("written %v, want the developer's agent told as before", written)
	}
}
