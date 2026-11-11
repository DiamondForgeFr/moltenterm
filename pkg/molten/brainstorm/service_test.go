// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

type fixture struct {
	store    *Store
	root     string
	lock     sync.Mutex
	versions []int64
	logs     []string
}

func (f *fixture) publish(version int64) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.versions = append(f.versions, version)
}

func (f *fixture) logf(format string, args ...any) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.logs = append(f.logs, fmt.Sprintf(format, args...))
}

func (f *fixture) service() *Service {
	clock := time.UnixMilli(1_790_000_000_000)
	return MakeService(f.store, func() time.Time { return clock }, f.publish, f.logf)
}

func makeFixture(t *testing.T) *fixture {
	t.Helper()
	store, root := makeTestStore(t)
	return &fixture{store: store, root: root}
}

func openingTurn() TurnRequest {
	b := block(
		centre("kids-video", "A safe video app for children"),
		add("ages", KindQuestion, "For which ages?", "kids-video"),
	)
	return TurnRequest{Key: "t1", You: "I have an app idea: videos for kids.", Brokk: "Let's put it on the anvil. For which ages?", Block: &b, At: 1000}
}

// FR-BOSS-010 AC2 (#2246): outside the mode a normal exchange is not kept; his answer with a central idea opens it.
func TestHisCentralIdeaOpensTheMode(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	plain := s.Turn(TurnRequest{Key: "q", You: "What time is it?", Brokk: "Ten past two."})
	if plain.State.Open || plain.Applied {
		t.Fatalf("a quick question opened the mode: %+v", plain)
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("a quick question was saved: %v", entries)
	}
	got := s.Turn(openingTurn())
	if !got.State.Open || got.State.By != ByBrokk || !got.Applied {
		t.Fatalf("his central idea did not open the mode: %+v", got)
	}
	if got.State.Graph == nil || got.State.Graph.Centre != "kids-video" || len(got.State.Graph.Nodes) != 2 {
		t.Errorf("graph %+v", got.State.Graph)
	}
	if got.State.Brainstorm == nil || got.State.Brainstorm.Slug != "a-safe-video-app-for-children" || got.State.Brainstorm.Turns != 2 {
		t.Errorf("brainstorm %+v", got.State.Brainstorm)
	}
	if got.State.SavedAt == 0 || got.State.SaveError != "" {
		t.Errorf("saved at %d: %q", got.State.SavedAt, got.State.SaveError)
	}
	if len(f.versions) == 0 {
		t.Error("the views were not told")
	}
}

// AC7: each turn is in the folder when it ends, and a restart resumes the graph when the developer starts the mode.
func TestEachTurnIsSavedAndARestartResumesIt(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	s.Turn(openingTurn())
	next := block(add("three-ten", KindAnswer, "From 3 to 10", "ages"), add("who-picks", KindQuestion, "Who picks the videos?", "kids-video"))
	s.Turn(TurnRequest{Key: "t2", You: "From 3 to 10.", Brokk: "Noted. Who picks the videos?", Block: &next, At: 2000})
	dir := s.State().Brainstorm.Dir
	saved, err := f.store.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Graph.Nodes) != 4 || len(saved.Turns) != 4 || saved.Info.Updated != 2000 {
		t.Fatalf("the folder holds %d nodes, %d turns, updated %d", len(saved.Graph.Nodes), len(saved.Turns), saved.Info.Updated)
	}
	if saved.Turns[2].Turn != 2 || saved.Turns[2].Role != RoleYou || saved.Turns[3].Role != RoleBrokk {
		t.Errorf("turns %+v", saved.Turns)
	}
	s.Close()

	restarted := f.service()
	state := restarted.Open(OpenRequest{By: ByYou})
	if !state.Open || state.Graph == nil || len(state.Graph.Nodes) != 4 || state.Brainstorm.Dir != dir {
		t.Fatalf("after a restart the developer's start shows %+v", state)
	}
	more := block(add("parents-list", KindIdea, "Parents validate a list", "who-picks"))
	got := restarted.Turn(TurnRequest{Key: "t3", You: "The parents.", Brokk: "A list they validate, then.", Block: &more, At: 3000})
	if !got.Applied || len(got.State.Graph.Nodes) != 5 {
		t.Errorf("the resumed graph did not grow: %+v", got)
	}
}

func TestTheSameAnswerIsAppliedOnce(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	s.Turn(openingTurn())
	again := s.Turn(openingTurn())
	if !again.Duplicate || again.Applied || len(again.State.Graph.Nodes) != 2 || again.State.Brainstorm.Turns != 2 {
		t.Errorf("a second reading of the answer: %+v", again)
	}
}

// AC8: a bad block is dropped, logged without its content, and the turn's words are still kept.
func TestABadBlockIsLoggedWithoutItsContent(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	s.Turn(openingTurn())
	secret := "a secret idea nobody may read"
	bad := block(add("lost", KindIdea, secret, "nowhere"))
	got := s.Turn(TurnRequest{Key: "t2", You: "More.", Brokk: "Here.", Block: &bad, At: 2000})
	if !got.Dropped || got.Applied || len(got.State.Graph.Nodes) != 2 || got.State.Brainstorm.Turns != 4 {
		t.Errorf("a bad block: %+v", got)
	}
	f.lock.Lock()
	defer f.lock.Unlock()
	if len(f.logs) != 1 || strings.Contains(f.logs[0], secret) || strings.Contains(f.logs[0], "lost") {
		t.Errorf("logs %q", f.logs)
	}
}

// What the developer says before his first central idea (the mode they started themselves) joins that idea's folder.
func TestWordsBeforeTheCentreJoinItsFolder(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	opened := s.Open(OpenRequest{By: ByYou})
	if !opened.Open || opened.By != ByYou || opened.Graph != nil {
		t.Fatalf("the developer's start: %+v", opened)
	}
	s.Turn(TurnRequest{Key: "a", You: "Brainstorm: an app.", Brokk: "What does it do?", At: 500})
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("a folder before any idea: %v", entries)
	}
	got := s.Turn(openingTurn())
	if got.State.Brainstorm == nil || got.State.Brainstorm.Turns != 4 {
		t.Fatalf("the words before the centre were lost: %+v", got.State.Brainstorm)
	}
	saved, err := f.store.Load(got.State.Brainstorm.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Turns[0].Text != "Brainstorm: an app." || saved.Turns[2].Turn != 2 {
		t.Errorf("turns %+v", saved.Turns)
	}
}

// A central idea of another id starts its own folder; the first one stays as it was saved.
func TestAnotherIdeaGetsItsOwnFolder(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	first := s.Turn(openingTurn()).State.Brainstorm.Dir
	other := block(centre("family-budget", "A family budget"), add("who", KindQuestion, "Who spends?", "family-budget"))
	got := s.Turn(TurnRequest{Key: "t2", You: "Other idea: a budget.", Brokk: "A new one, then.", Block: &other, At: 2000})
	if got.State.Brainstorm.Dir == first || got.State.Graph.Centre != "family-budget" || len(got.State.Graph.Nodes) != 2 {
		t.Fatalf("another idea: %+v", got.State)
	}
	saved, err := f.store.Load(first)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Graph.Centre != "kids-video" || len(saved.Turns) != 2 {
		t.Errorf("the first idea changed: centre %s, %d turns", saved.Graph.Centre, len(saved.Turns))
	}
}

func TestClosingKeepsTheBrainstormForTheNextStart(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s := f.service()
	s.Turn(openingTurn())
	closed := s.Close()
	if closed.Open || closed.Graph == nil {
		t.Fatalf("closed: %+v", closed)
	}
	if again := s.Close(); again.Version != closed.Version {
		t.Error("closing a closed mode told the views")
	}
	reopened := s.Open(OpenRequest{By: ByYou})
	if !reopened.Open || reopened.Graph == nil || reopened.Graph.Centre != "kids-video" {
		t.Errorf("reopened: %+v", reopened)
	}
	// His answer opening a brainstorm after a close starts a new one, even when the developer's was resumed before.
	s.Close()
	fresh := s.Turn(TurnRequest{Key: "n", Block: blockPtr(block(centre("forge-notes", "Forge notes"))), At: 5000})
	if fresh.State.Graph.Centre != "forge-notes" {
		t.Errorf("a detected brainstorm continued the old one: %+v", fresh.State.Graph)
	}
}

func blockPtr(b Block) *Block {
	return &b
}

// AC1 and the security rationale: the windows and Electron main only, and never on a release channel.
func TestRouteCallersAndChannels(t *testing.T) {
	t.Parallel()
	e := routetest.Make(t)
	f := makeFixture(t)
	s := f.service()
	link, err := localroute.MakeLink(e.Router, s.route(func() bool { return buildchannel.BrainstormAllowed(buildchannel.Gold) }))
	if err != nil {
		t.Fatal(err)
	}
	notUi := append([]routetest.From{e.Terminal()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notUi, StateCommand, nil, "MoltenTerm windows only")
	routetest.MustRefuseWith(t, link, notUi, TurnCommand, map[string]any{"key": "x"}, "MoltenTerm windows only")
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		if _, errStr := routetest.Ask(t, link, from, StateCommand, nil); errStr != "" {
			t.Errorf("the state for %s: %s", from.Name, errStr)
		}
	}
	for _, channel := range []string{buildchannel.RC, buildchannel.Public, ""} {
		e := routetest.Make(t)
		refused, err := localroute.MakeLink(e.Router, f.service().route(func() bool { return buildchannel.BrainstormAllowed(channel) }))
		if err != nil {
			t.Fatal(err)
		}
		for _, command := range []string{StateCommand, OpenCommand, CloseCommand, TurnCommand} {
			if _, errStr := routetest.Ask(t, refused, e.Window(), command, map[string]any{}); !strings.Contains(errStr, buildchannel.BrainstormRefusal) {
				t.Errorf("%q on channel %q: %q, want the plain refusal", command, channel, errStr)
			}
		}
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Errorf("a refused route made folders: %v", entries)
	}
}
