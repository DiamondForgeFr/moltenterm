// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

type feedLog struct {
	lock  sync.Mutex
	feeds []MaterialFeed
}

func (l *feedLog) add(f MaterialFeed) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.feeds = append(l.feeds, f)
}

func (l *feedLog) take() []MaterialFeed {
	l.lock.Lock()
	defer l.lock.Unlock()
	rtn := l.feeds
	l.feeds = nil
	return rtn
}

// The materials registry gets the signals of the records the checkpoint's reader already read (FR-MAT-001): once
// each, with the pane, and the hook's end of turn.
func TestUpdaterFeedsMaterials(t *testing.T) {
	repo := makeRepo(t, "feature/1425-materials")
	roots := t.TempDir()
	transcript := filepath.Join(roots, "claude", "projects", companion.ClaudeSlug(repo), "aaaaaaaa-1111-2222-3333-444444444444.jsonl")
	os.MkdirAll(filepath.Dir(transcript), 0o755)
	os.WriteFile(transcript, []byte(`{"type":"user","sessionId":"aaaaaaaa-1111-2222-3333-444444444444","cwd":"`+repo+`","timestamp":"2026-10-30T10:00:00Z","message":{"role":"user","content":"Publish the page"}}
{"type":"frame-link","sessionId":"aaaaaaaa-1111-2222-3333-444444444444","path":"/tmp/x/page.html","frameUrl":"https://claude.ai/artifact/U1","title":"Page","timestamp":"2026-10-30T10:00:01Z"}
`), 0o644)
	h := makeHarness(t, roots)
	log := &feedLog{}
	h.u.materials = log.add
	h.addPane(&testPane{blockId: "b1", wsId: "ws-1", agent: molten.AgentIdClaude, path: transcript, folder: repo, state: molten.AgentStateWorking})

	h.u.Tick()
	feeds := log.take()
	var published []companion.MaterialSignal
	for _, f := range feeds {
		if f.BlockId != "b1" || f.Agent != molten.AgentIdClaude {
			t.Errorf("feed %+v", f)
		}
		for _, sig := range f.Batch.Signals {
			if sig.Kind == companion.SignalPublished {
				published = append(published, sig)
			}
		}
	}
	if len(published) != 1 || published[0].Url != "https://claude.ai/artifact/U1" {
		t.Fatalf("published %+v (feeds %+v)", published, feeds)
	}
	h.u.Tick()
	for _, f := range log.take() {
		if len(f.Batch.Signals) > 0 {
			t.Errorf("a signal was handed over twice: %+v", f.Batch.Signals)
		}
	}
	h.u.TurnEnded("b1", molten.AgentIdClaude)
	ended := false
	for _, f := range log.take() {
		ended = ended || (f.TurnEnded && f.BlockId == "b1")
	}
	if !ended {
		t.Errorf("the hook's end of turn was not handed over")
	}
}

// An agent no transcript is linked to is offered to the registry (its terminal's output), at most every 15 s.
func TestUpdaterOffersUnlinkedAgents(t *testing.T) {
	roots := t.TempDir()
	h := makeHarness(t, roots)
	log := &feedLog{}
	h.u.materials = log.add
	h.addPane(&testPane{blockId: "b2", wsId: "ws-1", agent: "gemini", state: molten.AgentStateWorking})
	h.u.Tick()
	h.u.Tick()
	n := 0
	for _, f := range log.take() {
		if f.Unlinked && f.BlockId == "b2" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("offered %d times in one interval", n)
	}
	h.clock.add(terminalFeedInterval)
	h.u.Tick()
	n = 0
	for _, f := range log.take() {
		if f.Unlinked {
			n++
		}
	}
	if n != 1 {
		t.Errorf("not offered again after the interval: %d", n)
	}
}
