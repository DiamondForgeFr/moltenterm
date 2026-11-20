// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubAgent stands for the summary model (#2392, TC-SHELL-018-5): it answers one sentence per ticket the prompt names,
// in the prompt's language, and records every prompt. hold, when set, keeps a run going until it is closed.
type stubAgent struct {
	lock    sync.Mutex
	prompts []string
	fail    bool
	hold    chan struct{}
}

var promptTicketRegex = regexp.MustCompile(`(?m)^#(\d+)$`)

func (a *stubAgent) run(_ context.Context, agent string, prompt string) ([]byte, error) {
	a.lock.Lock()
	a.prompts = append(a.prompts, prompt)
	hold, fail := a.hold, a.fail
	a.lock.Unlock()
	if hold != nil {
		<-hold
	}
	if fail {
		return nil, errors.New("the model is not available")
	}
	lang := "en"
	if strings.Contains(prompt, "in French") {
		lang = "fr"
	}
	var b strings.Builder
	b.WriteString("Here are the sentences:\n")
	for _, m := range promptTicketRegex.FindAllStringSubmatch(prompt, -1) {
		fmt.Fprintf(&b, "%s\tSentence %s for ticket %s, written by %s.\n", m[1], lang, m[1], agent)
	}
	return []byte(b.String()), nil
}

func (a *stubAgent) count() int {
	a.lock.Lock()
	defer a.lock.Unlock()
	return len(a.prompts)
}

func (a *stubAgent) last() string {
	a.lock.Lock()
	defer a.lock.Unlock()
	if len(a.prompts) == 0 {
		return ""
	}
	return a.prompts[len(a.prompts)-1]
}

// phrasingEnv is a developer who turned the sentences on, with an agent that can write them.
func phrasingEnv(agent *stubAgent) Env {
	return Env{Agent: func(string) string { return "claude" }, RunPrint: agent.run, SummariesOn: func() bool { return true }}
}

func sentences(m *Milestone) map[int]string {
	rtn := map[int]string{}
	for _, t := range m.Tickets {
		rtn[t.Number] = t.Sentence
	}
	return rtn
}

// shown is the rows a companion shows of shopForge's milestone: it asks for their sentences.
var shown = []int{41, 38, 35}

// readMilestone lets the first read end, so the next asks find the tickets.
func (f *fixture) readMilestone(t *testing.T) {
	t.Helper()
	f.svc.Get(GetRequest{Dir: f.dir, Shown: true})
	f.svc.waitIdle()
}

// TC-SHELL-018-5: written once per ticket, content (its cleaned title and excerpt) and language; asked again only when
// one of them changes. A comment, a label or a move changes nothing of what is sent: no new sentence.
func TestSentencesAreCachedPerTicketContentAndLanguage(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	view := f.get("fr", shown...)
	if agent.count() != 1 {
		t.Fatalf("batches: %d, want 1", agent.count())
	}
	got := sentences(view.first())
	if got[41] != "Sentence fr for ticket 41, written by claude." || got[38] == "" || got[35] == "" {
		t.Errorf("sentences: %v", got)
	}
	for i := 0; i < 5; i++ {
		f.get("fr", shown...)
	}
	if agent.count() != 1 {
		t.Errorf("an unchanged ticket was asked again: %d batches", agent.count())
	}
	view = f.get("en", shown...)
	if agent.count() != 2 || sentences(view.first())[41] != "Sentence en for ticket 41, written by claude." {
		t.Errorf("another language: %d batches, %v", agent.count(), sentences(view.first()))
	}

	// A comment or a label: the ticket moves on the forge, what is sent of it does not.
	f.forge.set(func(ff *fakeForge) { ff.issues[2][1], ff.issues[2][0] = ff.issues[2][0], ff.issues[2][1] })
	f.clock.Add(2 * time.Minute)
	f.get("fr", shown...)
	f.get("fr", shown...)
	if agent.count() != 2 {
		t.Fatalf("a ticket whose title and body did not change was asked again: %d batches, want 2", agent.count())
	}

	f.forge.set(func(ff *fakeForge) {
		for i := range ff.issues[2] {
			if ff.issues[2][i].Number == 41 {
				ff.issues[2][i].Title = "Checkout total shown twice on mobile"
			}
		}
	})
	f.clock.Add(2 * time.Minute)
	f.get("fr", shown...)
	view = f.get("fr", shown...)
	if agent.count() != 3 {
		t.Fatalf("a retitled ticket: %d batches, want 3", agent.count())
	}
	if prompt := agent.last(); !strings.Contains(prompt, "#41\n") || strings.Contains(prompt, "#38\n") {
		t.Errorf("only the retitled ticket is asked again:\n%s", prompt)
	}
	if sentences(view.first())[41] == "" {
		t.Errorf("the retitled ticket has its new sentence: %v", sentences(view.first()))
	}

	// After a restart, the sentences kept on disk are not asked again.
	saved := f.rec.lastSaved()
	restarted := phrasingEnv(agent)
	restarted.Load = func() StoreFile { return saved }
	forge := shopForge()
	forge.issues[2][0].Title = "Checkout total shown twice on mobile"
	again := makeFixture(t, forge, restarted)
	again.readMilestone(t)
	view = again.get("fr", shown...)
	if agent.count() != 3 || sentences(view.first())[38] == "" {
		t.Errorf("after a restart: %d batches, %v", agent.count(), sentences(view.first()))
	}
}

// A missing or failed sentence leaves the title, nothing waits for it, and the ticket is asked again an hour later.
func TestAFailedBatchLeavesTheTitles(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{fail: true}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	view := f.get("fr", shown...)
	for _, ticket := range view.first().Tickets {
		if ticket.Sentence != "" || ticket.Title == "" {
			t.Errorf("ticket: %+v", ticket)
		}
	}
	f.clock.Add(30 * time.Minute)
	f.get("fr", shown...)
	if agent.count() != 1 {
		t.Errorf("a failed ticket was asked again within the hour: %d batches", agent.count())
	}
	f.clock.Add(31 * time.Minute)
	f.get("fr", shown...)
	if agent.count() != 2 {
		t.Errorf("a failed ticket is asked again after an hour: %d batches", agent.count())
	}
}

// The cap: one batch at a time, at most MaxShown tickets each, maxBatchesPerHour an hour and maxBatchesPerDay a day.
func TestTheCallCapHolds(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{hold: make(chan struct{})}
	forge := shopForge()
	var many []forgeIssue
	for n := 100; n < 120; n++ {
		many = append(many, issue(n, fmt.Sprintf("Ticket %d", n)))
	}
	forge.issues[2] = many
	forge.milestones[1].Open.TotalCount = len(many)
	f := makeFixture(t, forge, phrasingEnv(agent))
	f.readMilestone(t)
	var rows []int
	for n := 100; n < 112; n++ {
		rows = append(rows, n)
	}
	for i := 0; i < 10; i++ {
		view := f.svc.Get(GetRequest{Dir: f.dir, Lang: "fr", Want: rows, Shown: true})
		if !view.Phrasing {
			t.Errorf("ask %d: the view does not say a batch runs", i)
		}
	}
	// The counts are on disk before the run ends: a quit during it still spends its place.
	if saved := f.rec.lastSaved(); saved.Batches != 1 || len(saved.Hour) != 1 || saved.Day != "2026-11-19" {
		t.Errorf("while the first batch runs, the store holds %d batches today and %d this hour", saved.Batches, len(saved.Hour))
	}
	close(agent.hold)
	f.svc.waitIdle()
	if agent.count() != 1 {
		t.Fatalf("batches started while one ran: %d, want 1", agent.count())
	}
	if asked := len(promptTicketRegex.FindAllString(agent.last(), -1)); asked != MaxShown {
		t.Errorf("tickets in one batch: %d, want %d", asked, MaxShown)
	}

	agent.lock.Lock()
	agent.hold = nil
	agent.lock.Unlock()
	langs := []string{"en", "de", "es", "it", "pt", "nl", "sv", "da"}
	for _, lang := range langs {
		f.get(lang, rows...)
	}
	if agent.count() != maxBatchesPerHour {
		t.Errorf("batches in one hour: %d, want %d", agent.count(), maxBatchesPerHour)
	}
	for hour := 1; hour <= 6; hour++ {
		f.clock.Add(time.Hour)
		for _, lang := range langs {
			f.get(fmt.Sprintf("%s-x%d", lang, hour), rows...)
		}
	}
	if agent.count() != maxBatchesPerDay {
		t.Errorf("batches in one day: %d, want %d", agent.count(), maxBatchesPerDay)
	}
	if saved := f.rec.lastSaved(); saved.Batches != maxBatchesPerDay || saved.Day != "2026-11-19" {
		t.Errorf("the day's count is kept on disk: %+v", saved.Day)
	}
}

// The hour's and the day's counts survive a restart: a restarted app does not get a fresh cap.
func TestTheCountsSurviveARestart(t *testing.T) {
	t.Parallel()
	recent := []int64{}
	for i := 0; i < maxBatchesPerHour; i++ {
		recent = append(recent, epoch.Add(-time.Duration(i+1)*time.Minute).UnixMilli())
	}
	agent := &stubAgent{}
	env := phrasingEnv(agent)
	env.Load = func() StoreFile {
		return StoreFile{Version: storeVersion, Hour: recent, Day: "2026-11-19", Batches: maxBatchesPerHour}
	}
	f := makeFixture(t, shopForge(), env)
	f.readMilestone(t)
	f.get("fr", shown...)
	if agent.count() != 0 {
		t.Errorf("the hour's batches spent before a restart were given back: %d batches", agent.count())
	}

	full := phrasingEnv(agent)
	full.Load = func() StoreFile {
		return StoreFile{Version: storeVersion, Day: "2026-11-19", Batches: maxBatchesPerDay}
	}
	g := makeFixture(t, shopForge(), full)
	g.readMilestone(t)
	g.get("fr", shown...)
	if agent.count() != 0 {
		t.Errorf("the day's batches spent before a restart were given back: %d batches", agent.count())
	}
}

// Nothing is written, nor shown, until the developer turns the sentences on and agrees (#2392): titles only.
func TestNothingIsWrittenUntilTurnedOn(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	on := false
	env := phrasingEnv(agent)
	env.SummariesOn = func() bool { return on }
	f := makeFixture(t, shopForge(), env)
	f.readMilestone(t)
	view := f.get("fr", shown...)
	if agent.count() != 0 || view.Summaries || !view.Phrasable || sentences(view.first())[41] != "" {
		t.Fatalf("off: %d batches, summaries %v, phrasable %v", agent.count(), view.Summaries, view.Phrasable)
	}
	on = true
	view = f.get("fr", shown...)
	if agent.count() != 1 || !view.Summaries || sentences(view.first())[41] == "" {
		t.Fatalf("turned on: %d batches, %v", agent.count(), sentences(view.first()))
	}
	on = false
	view = f.get("fr", shown...)
	if sentences(view.first())[41] != "" {
		t.Errorf("turned off again, a sentence written earlier still shows: %v", sentences(view.first()))
	}
}

// A hidden companion never starts a batch, even with the sentences on and none written yet.
func TestAHiddenCompanionStartsNoBatch(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	for i := 0; i < 3; i++ {
		f.svc.Get(GetRequest{Dir: f.dir, Lang: "fr", Want: shown})
	}
	f.svc.waitIdle()
	if agent.count() != 0 {
		t.Errorf("a hidden companion started %d batches", agent.count())
	}
}

// The prompt holds each ticket's number, title and first lines, cleaned; nothing of the repository or of a person.
func TestThePromptHoldsOnlyTitlesAndExcerpts(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	forge := shopForge()
	forge.issues[2][0].Title = "Checkout total shown twice (reported by @alice, alice@example.com)"
	forge.issues[2][0].Body = "<!-- template: bug -->\n## What happens\nThe **total** shows twice, see [the log](https://example.com/log/1) and " +
		"https://example.com/screenshot.png, cc @bob.\n![shot](https://example.com/a.png)\n```\nconst secret = readFile(\"/etc/passwd\")\n```\n" +
		"| a | b |\n|---|---|\nwrite to dev@example.com"
	f := makeFixture(t, forge, phrasingEnv(agent))
	f.readMilestone(t)
	f.get("fr", shown...)
	prompt := agent.last()
	for _, want := range []string{"in French", "#41\nTitle: Checkout total shown twice (reported by ,", "Excerpt: What happens The total shows twice, see the log and cc .", "#38\n", "#35\n"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the prompt lacks %q:\n%s", want, prompt)
		}
	}
	for _, never := range []string{"@alice", "alice@example.com", "@bob", "https://", "example.com", "secret", "/etc/passwd", "template", f.dir, "|---|"} {
		if strings.Contains(prompt, never) {
			t.Errorf("the prompt holds %q:\n%s", never, prompt)
		}
	}
}

func TestParseSentences(t *testing.T) {
	t.Parallel()
	tickets := []Ticket{{Number: 41, Title: "Checkout total shown twice"}, {Number: 38, Title: "Receipt language"}, {Number: 35, Title: "Faster product search"}}
	out := "Sure! Here they are:\n" +
		"#41\tLe total du panier ne s'affichera plus deux fois.\n" +
		"38: \"Le reçu partira dans la langue de l'acheteur.\"\n" +
		"35 - Faster product search.\n" +
		"35\tok\n" +
		"99\tUne ligne pour un ticket jamais demandé.\n" +
		"41\tUne seconde phrase pour le même ticket.\n"
	got := parseSentences([]byte(out), tickets)
	want := map[int]string{41: "Le total du panier ne s'affichera plus deux fois.", 38: "Le reçu partira dans la langue de l'acheteur."}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if cleanSentence("Search", "Search") != "" || cleanSentence("Checkout total shown twice.", "Checkout total shown twice") != "" {
		t.Error("a sentence that repeats the title is no sentence")
	}
}

// The companion's shown tickets are phrased first, in its order; its batch never holds a ticket it did not ask for.
func TestTheShownTicketsArePhrased(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	view := f.get("fr", 35, 999)
	got := sentences(view.first())
	if got[35] == "" || got[41] != "" || got[38] != "" {
		t.Errorf("sentences: %v", got)
	}
	if strings.Contains(agent.last(), "#999") {
		t.Error("a ticket that is not in the milestone was asked")
	}
	if prompt := agent.last(); strings.Contains(prompt, "#41\n") || strings.Contains(prompt, "#38\n") {
		t.Errorf("the batch holds tickets the companion did not ask for:\n%s", prompt)
	}
}

// A companion that has not said which rows it shows gets no batch: none is spent on a ticket it would not show.
func TestNoSentenceWithoutTheShownRows(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	view := f.get("fr")
	if agent.count() != 0 || view.Phrasing || sentences(view.first())[41] != "" {
		t.Errorf("without the shown rows: %d batches, phrasing %v", agent.count(), view.Phrasing)
	}
}

// Each batch's time counts as the agent's use; an agent without a quick form writes nothing.
func TestBatchesCountAsUseAndNeedAnAgent(t *testing.T) {
	t.Parallel()
	agent := &stubAgent{}
	f := makeFixture(t, shopForge(), phrasingEnv(agent))
	f.readMilestone(t)
	f.get("fr", shown...)
	if len(f.rec.uses) != 1 || !strings.HasPrefix(f.rec.uses[0], "claude ") {
		t.Errorf("uses: %v", f.rec.uses)
	}

	none := &stubAgent{}
	g := makeFixture(t, shopForge(), Env{Agent: func(string) string { return "" }, RunPrint: none.run})
	g.readMilestone(t)
	view := g.get("fr", shown...)
	if none.count() != 0 || view.Phrasing {
		t.Errorf("without an agent: %d batches, phrasing %v", none.count(), view.Phrasing)
	}
}
