// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const (
	ourRepo   = "/work/moltenterm"
	otherRepo = "/work/elsewhere"
)

var (
	lead     = Agent{BlockId: "b-lead", FirstName: "Olivia", AgentName: "Claude Code", Workspace: "MoltenTerm", Folder: ourRepo, ProjectDir: ourRepo}
	worker   = Agent{BlockId: "b-worker", FirstName: "Paul", AgentName: "Codex", Workspace: "MoltenTerm", Folder: ourRepo + "/.claude/worktrees/agent-1", ProjectDir: ourRepo}
	stranger = Agent{BlockId: "b-other", FirstName: "Zoé", AgentName: "Claude Code", Workspace: "Client", Folder: otherRepo, ProjectDir: otherRepo}
)

// raisedPanic makes a watcher whose log raised one panic card, and answers its signature's id.
func raisedPanic(t *testing.T, excerptText string) (*Watcher, *fakeEnv, string) {
	t.Helper()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, panicLines(day.Add(time.Minute), excerptText, "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	cards := fe.takeCards()
	if len(cards) != 1 {
		t.Fatalf("cards: %v", cardKeys(cards))
	}
	fe.ours[ourRepo] = true
	return w, fe, strings.TrimPrefix(cards[0].Key, CardKeyPrefix)
}

// FR-BOSS-012 AC9, acceptance 2: the click sends one hand-off, to the lead of MoltenTerm's repository (the agent at its
// root, not the one in a worktree nor another project's), with the excerpt quoted as data; the card then says who looks.
func TestAskSendsOneBriefToTheLeadOfMoltenTermsRepository(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map in ```tricky``` text")
	fe.agents = []Agent{stranger, worker, lead}
	if len(fe.requests()) != 0 {
		t.Fatal("something was sent before the click")
	}
	res, err := w.Ask(context.Background(), AskRequest{Id: id})
	if err != nil || res.Status != AskSent || res.To != "Olivia" {
		t.Fatalf("ask: %+v %v", res, err)
	}
	reqs := fe.requests()
	if len(reqs) != 1 || reqs[0].ToBlockId != lead.BlockId || reqs[0].Key != CardKeyPrefix+id || reqs[0].Closing != askClosing {
		t.Fatalf("requests: %+v", reqs)
	}
	if !strings.Contains(reqs[0].Goal, "a panic MoltenTerm recovered") || !strings.Contains(reqs[0].Goal, "usual ticket flow") {
		t.Fatalf("goal %q", reqs[0].Goal)
	}
	brief := reqs[0].Context
	for _, want := range []string{dataNote, privacyNote, "````text\n[wavesrv] [panic] in molten:fake:loop: nil map in ```tricky``` text\n",
		"~/src/pkg/molten/fake/worker.go:42", "`pkg/molten/fake.(*worker).step`", "channel `gold`, version `1.0.0-test`"} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief lacks %q:\n%s", want, brief)
		}
	}
	if strings.Contains(brief, fakeHome) {
		t.Fatalf("the brief names the home folder:\n%s", brief)
	}
	cards := fe.takeCards()
	if len(cards) != 1 || !cards[0].RefreshOnly || !strings.HasPrefix(cards[0].Message, "Olivia is having a look. I spotted it once") ||
		cards[0].MessageText.Code != "logwatch.message.asked" || cards[0].MessageText.Parts["rest"] == nil {
		t.Fatalf("card after the ask: %+v", cards)
	}
}

// A first name locked for MoltenTerm's project is its lead, even in a worktree (FR-CONT-014).
func TestAskPrefersTheLockedName(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	fe.agents = []Agent{lead, worker}
	fe.locks = []molten.AgentNameLock{{Name: "Zoé", Project: otherRepo}, {Name: "paul", Project: ourRepo}}
	res, err := w.Ask(context.Background(), AskRequest{Id: id})
	if err != nil || res.Status != AskSent || fe.requests()[0].ToBlockId != worker.BlockId {
		t.Fatalf("ask: %+v %v %+v", res, err, fe.requests())
	}
}

// With no lead that stands out, nothing is sent: the developer picks among the agents of MoltenTerm's repository, at its
// root first, then in its worktrees; another project's agent is never offered. A pick sends, a pick of an agent that has
// gone sends nothing.
func TestAskLetsTheDeveloperPick(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	second := Agent{BlockId: "b-lead2", FirstName: "Hugo", AgentName: "Codex", Workspace: "MoltenTerm 2", Folder: ourRepo, ProjectDir: ourRepo}
	fe.agents = []Agent{stranger, worker, lead, second}
	res, err := w.Ask(context.Background(), AskRequest{Id: id})
	if err != nil || res.Status != AskPick || len(fe.requests()) != 0 {
		t.Fatalf("ask: %+v %v", res, err)
	}
	var order []string
	for _, c := range res.Agents {
		order = append(order, c.FirstName)
	}
	if strings.Join(order, ",") != "Olivia,Hugo,Paul" || res.Agents[0].Project != "moltenterm" {
		t.Fatalf("offer: %+v", res.Agents)
	}
	res, err = w.Ask(context.Background(), AskRequest{Id: id, BlockId: worker.BlockId})
	if err != nil || res.Status != AskSent || res.To != "Paul" || len(fe.requests()) != 1 {
		t.Fatalf("picked: %+v %v", res, err)
	}
	res, err = w.Ask(context.Background(), AskRequest{Id: id, BlockId: "b-gone"})
	if err != nil || res.Status != AskGone || len(fe.requests()) != 1 {
		t.Fatalf("gone: %+v %v", res, err)
	}
}

// FR-BOSS-012 AC9 (D1 of the review): MoltenTerm's log never reaches another project's agent. One running alone is no
// recipient (nobody to ask), and one named by its terminal is refused.
func TestTheLogNeverGoesToAnotherProjectsAgent(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	fe.agents = []Agent{stranger}
	if res, err := w.Ask(context.Background(), AskRequest{Id: id}); err != nil || res.Status != AskNoAgent || len(res.Agents) != 0 {
		t.Fatalf("only a client project's agent runs: %+v %v", res, err)
	}
	if res, err := w.Ask(context.Background(), AskRequest{Id: id, BlockId: stranger.BlockId}); err != nil || res.Status != AskRefused {
		t.Fatalf("a client project's agent named by its terminal: %+v %v", res, err)
	}
	noProject := Agent{BlockId: "b-loose", FirstName: "Léa", Folder: "/tmp/somewhere"}
	fe.agents = []Agent{stranger, noProject, lead}
	if res, err := w.Ask(context.Background(), AskRequest{Id: id, BlockId: noProject.BlockId}); err != nil || res.Status != AskRefused {
		t.Fatalf("an agent in no project: %+v %v", res, err)
	}
	if len(fe.requests()) != 0 {
		t.Fatalf("sent: %+v", fe.requests())
	}
}

// A second click while the first request is on its way sends nothing.
func TestASecondClickWhileTheFirstIsOnItsWaySendsNothing(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	fe.agents = []Agent{lead}
	started := make(chan struct{})
	release := make(chan struct{})
	fe.onSend = func() {
		close(started)
		<-release
	}
	first := make(chan AskResult, 1)
	go func() {
		res, _ := w.Ask(context.Background(), AskRequest{Id: id})
		first <- res
	}()
	<-started
	if res, err := w.Ask(context.Background(), AskRequest{Id: id}); err != nil || res.Status != AskBusy {
		t.Fatalf("second click: %+v %v", res, err)
	}
	close(release)
	if res := <-first; res.Status != AskSent {
		t.Fatalf("first click: %+v", res)
	}
	if n := len(fe.requests()); n != 1 {
		t.Fatalf("%d requests sent", n)
	}
}

func TestAskWithNobodyOrNothingToAskAbout(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	if res, err := w.Ask(context.Background(), AskRequest{Id: id}); err != nil || res.Status != AskNoAgent {
		t.Fatalf("no agent: %+v %v", res, err)
	}
	fe.agents = []Agent{lead}
	if res, err := w.Ask(context.Background(), AskRequest{Id: "0000000000000000"}); err != nil || res.Status != AskUnknown {
		t.Fatalf("unknown: %+v %v", res, err)
	}
	if res, err := w.Ask(context.Background(), AskRequest{Id: GrowthId}); err != nil || res.Status != AskUnknown {
		t.Fatalf("a growth never raised: %+v %v", res, err)
	}
	fe.sendErr = errors.New("no agent runs in that terminal")
	_, err := w.Ask(context.Background(), AskRequest{Id: id})
	if text := uimsg.TextOf(err); text == nil || text.Code != "logwatch.sendFailed" {
		t.Fatalf("a failed send: %v", err)
	}
	if len(fe.requests()) != 0 {
		t.Fatal("something was sent")
	}
}

// The brief of a log that grows names the figure and quotes what was seen most in that hour.
func TestTheGrowthBriefQuotesWhatWritesMost(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, errorsEveryMinute(day, 3, 3, "[wavesrv] error: the busy one")+stamped(day, "[wavesrv] error: the rare one"))
	fe.advance(5 * time.Minute)
	look(t, w)
	w.state.Growth = growthMark{Raised: fe.clock().UnixMilli(), Bytes: 64 << 20}
	fe.agents = []Agent{lead}
	fe.ours[ourRepo] = true
	res, err := w.Ask(context.Background(), AskRequest{Id: GrowthId})
	if err != nil || res.Status != AskSent {
		t.Fatalf("ask: %+v %v", res, err)
	}
	req := fe.requests()[0]
	busy := strings.Index(req.Context, "the busy one")
	rare := strings.Index(req.Context, "the rare one")
	if !strings.Contains(req.Goal, "grow by 64 MB in an hour") || busy < 0 || rare < 0 || busy > rare || !strings.Contains(req.Context, privacyNote) {
		t.Fatalf("growth brief:\n%s\n%s", req.Goal, req.Context)
	}
}

// AC1, AC12: the commands refuse where the watch is off, and answer MoltenTerm's windows only.
func TestTheCommandsAreForTheWindowsAndOnlyWhenTheWatchRuns(t *testing.T) {
	t.Parallel()
	w, fe, id := raisedPanic(t, "nil map")
	fe.agents = []Agent{lead}
	policy := w.route().Policy
	for name, caller := range map[string]localroute.Caller{
		"a terminal": {IsLocalTerminal: true, BlockId: "b1"}, "Electron main": {IsElectron: true}, "an unknown caller": {},
	} {
		for _, command := range []string{AskCommand, MuteCommand} {
			if policy.Admits(command, caller) {
				t.Errorf("%s may send %s", name, command)
			}
		}
	}
	if !policy.Admits(AskCommand, localroute.Caller{IsWindow: true, TabId: "t"}) {
		t.Error("a window may not ask")
	}
	fe.setEnabled(false)
	if _, err := w.handle(context.Background(), AskCommand, map[string]any{"id": id}); !errors.Is(err, ErrOff) {
		t.Fatalf("ask while off: %v", err)
	}
	if err := w.Mute(context.Background(), MuteRequest{Id: id}); !errors.Is(err, ErrOff) {
		t.Fatalf("mute while off: %v", err)
	}
	if len(fe.requests()) != 0 {
		t.Fatal("sent while off")
	}
	fe.setEnabled(true)
	if _, err := w.handle(context.Background(), MuteCommand, map[string]any{"id": id}); err != nil || !w.state.muted(id) {
		t.Fatalf("mute: %v", err)
	}
	if _, err := w.handle(context.Background(), "moltenlogwatchnope", nil); err == nil {
		t.Fatal("an unknown command was answered")
	}
}

func TestChooseRecipient(t *testing.T) {
	t.Parallel()
	ours := func(dir string) bool { return dir == ourRepo }
	if to, offer := chooseRecipient(nil, nil, ours); to != nil || len(offer) != 0 {
		t.Fatalf("nobody: %v %v", to, offer)
	}
	if to, _ := chooseRecipient([]Agent{worker, lead, stranger}, nil, ours); to == nil || to.BlockId != lead.BlockId {
		t.Fatalf("the only agent at the root: %v", to)
	}
	to, offer := chooseRecipient([]Agent{worker, stranger}, nil, ours)
	if to != nil || len(offer) != 1 || offer[0].FirstName != "Paul" {
		t.Fatalf("only a worktree agent of ours: %v %+v", to, offer)
	}
	if to, offer := chooseRecipient([]Agent{stranger}, []molten.AgentNameLock{{Name: "Zoé", Project: otherRepo}}, ours); to != nil || len(offer) != 0 {
		t.Fatalf("a name locked for another project chose or offered its agent: %v %+v", to, offer)
	}
	many := make([]Agent, 30)
	for i := range many {
		many[i] = Agent{BlockId: string(rune('a' + i)), FirstName: "x", ProjectDir: ourRepo, Folder: ourRepo + "/.claude/worktrees/w"}
	}
	if _, offer := chooseRecipient(append(many, stranger), nil, ours); len(offer) != maxOffered {
		t.Fatalf("offered %d", len(offer))
	}
}

func TestGithubRepoOf(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"https://github.com/DiamondForgeFr/moltenterm":     "diamondforgefr/moltenterm",
		"https://github.com/DiamondForgeFr/moltenterm.git": "diamondforgefr/moltenterm",
		"git@github.com:DiamondForgeFr/MoltenTerm.git":     "diamondforgefr/moltenterm",
		"ssh://git@github.com/DiamondForgeFr/moltenterm/":  "diamondforgefr/moltenterm",
		"https://github.com/wavetermdev/waveterm":          "wavetermdev/waveterm",
		"https://gitlab.example/DiamondForgeFr/moltenterm": "",
		"": "",
	}
	for url, want := range cases {
		if got := GithubRepoOf(url); got != want {
			t.Errorf("GithubRepoOf(%q) = %q, want %q", url, got, want)
		}
	}
	if moltenRepo != "diamondforgefr/moltenterm" {
		t.Fatalf("MoltenTerm's own repository reads %q", moltenRepo)
	}
}

// The fence is longer than any run of backticks inside, so the log's text never closes it.
func TestTheFenceOutlastsTheBackticksInside(t *testing.T) {
	t.Parallel()
	for text, fence := range map[string]string{"plain": "```", "a `b`": "```", "x ``` y": "````", "`````": "``````"} {
		got := fenced(text)
		if !strings.HasPrefix(got, fence+"text\n") || !strings.HasSuffix(got, "\n"+fence+"\n") || strings.HasPrefix(got, fence+"`") {
			t.Errorf("fenced(%q) = %q, want fence %q", text, got, fence)
		}
	}
}
