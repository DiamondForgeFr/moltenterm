// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func errorsEveryMinute(from time.Time, minutes int, perMinute int, text string) string {
	var sb strings.Builder
	for m := 0; m < minutes; m++ {
		for i := 0; i < perMinute; i++ {
			sb.WriteString(stamped(from.Add(time.Duration(m)*time.Minute+time.Duration(i)*time.Second), text))
		}
	}
	return sb.String()
}

// FR-BOSS-012 AC6, AC8, acceptance 1: a synthetic log with a new panic gives one card in Brokk's notes: calm (already
// read, never a question), with what, how often, since when and a short excerpt, and its three actions.
func TestANewPanicRaisesOneCalmCard(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, panicLines(day.Add(time.Minute), "runtime error: index out of range [3] with length 3", "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	cards := fe.takeCards()
	if len(cards) != 1 || cards[0].RefreshOnly {
		t.Fatalf("cards: %v", cardKeys(cards))
	}
	card := cards[0]
	if !card.Quiet || card.Kind != "error" || card.Source != NotificationSource || !strings.HasPrefix(card.Key, CardKeyPrefix) {
		t.Fatalf("card: %+v", card)
	}
	if card.Title != "A new panic in the log" || card.TitleText.Code != "logwatch.title.newPanic" {
		t.Fatalf("title %q %+v", card.Title, card.TitleText)
	}
	wantMessage := "I spotted it once since 10:01: `[panic] in molten:fake:loop: runtime error: index out of range [3] " +
		"with length 3` in `pkg/molten/fake.(*worker).step`"
	if card.Message != wantMessage || card.MessageText.Code != "logwatch.message.newAt" || card.MessageText.Parts["times"].Code != "logwatch.times.one" {
		t.Fatalf("message %q\n%+v", card.Message, card.MessageText)
	}
	gestures := map[string]bool{}
	for _, a := range card.Actions {
		gestures[a.Gesture] = true
	}
	if len(card.Actions) != 3 || !gestures[AskGesture] || !gestures[MuteGesture] || !gestures[RevealGesture] {
		t.Fatalf("actions: %+v", card.Actions)
	}
	if card.Actions[2].Args["path"] != path {
		t.Fatalf("Show in folder points at %v", card.Actions[2].Args)
	}
	look(t, w)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("a look with nothing new published %v", cardKeys(cards))
	}
}

// Acceptance 1: a spike of a known signature gives one card; an error alone, however new, gives none.
func TestASpikeOfAKnownErrorRaisesOneCard(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, stamped(day, "[wavesrv] error syncing the board: timeout after 30s"))
	fe.advance(time.Minute)
	look(t, w)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("a single new error raised %v", cardKeys(cards))
	}
	appendLog(t, path, errorsEveryMinute(day.Add(2*time.Minute), 5, 2, "[wavesrv] error syncing the board: timeout after 31s"))
	fe.advance(7 * time.Minute)
	look(t, w)
	cards := fe.takeCards()
	if len(cards) != 1 || cards[0].RefreshOnly || cards[0].Title != "An error keeps coming back" || cards[0].Kind != "info" {
		t.Fatalf("cards: %v", cardKeys(cards))
	}
	if !strings.HasPrefix(cards[0].Message, "About 2 a minute lately, 11 times since 10:00: `error syncing the board: timeout after 31s`") ||
		cards[0].MessageText.Code != "logwatch.message.spike" {
		t.Fatalf("message %q", cards[0].Message)
	}
}

// A burst in one minute is no spike: more than one a minute means over several minutes.
func TestABurstInOneMinuteIsNoSpike(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, errorsEveryMinute(day, 1, 30, "[wavesrv] error: the cache warms up"))
	fe.advance(2 * time.Minute)
	look(t, w)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("a one-minute burst raised %v", cardKeys(cards))
	}
}

// AC7, acceptance 1: the same signature gives no other card that day; while its card is open its figures are brought up
// to date in place; a day later a new spike raises it again; another signature raises its own card.
func TestTheSameSignatureRaisesOnceADay(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, panicLines(day.Add(time.Minute), "nil map", "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	first := raised(fe.takeCards())
	if len(first) != 1 {
		t.Fatalf("first look: %v", cardKeys(first))
	}
	var spike strings.Builder
	for m := 3; m < 9; m++ {
		spike.WriteString(panicLines(day.Add(time.Duration(m)*time.Minute), "nil map", "step"))
		spike.WriteString(panicLines(day.Add(time.Duration(m)*time.Minute+time.Second), "nil map", "step"))
	}
	appendLog(t, path, spike.String())
	fe.advance(10 * time.Minute)
	look(t, w)
	cards := fe.takeCards()
	if len(cards) != 1 || !cards[0].RefreshOnly || cards[0].Key != first[0].Key || cards[0].Title != "A panic keeps coming back" {
		t.Fatalf("the same day: %v", cardKeys(cards))
	}
	if !strings.Contains(cards[0].Message, "13 times since 10:01") {
		t.Fatalf("refreshed message %q", cards[0].Message)
	}
	appendLog(t, path, panicLines(day.Add(15*time.Minute), "nil map", "flush"))
	fe.advance(5 * time.Minute)
	look(t, w)
	other := fe.takeCards()
	if len(raised(other)) != 1 || raised(other)[0].Key == first[0].Key {
		t.Fatalf("another signature: %v", cardKeys(other))
	}
	fe.advance(25 * time.Hour)
	later := fe.clock()
	var again strings.Builder
	for m := -6; m < 0; m++ {
		again.WriteString(panicLines(later.Add(time.Duration(m)*time.Minute), "nil map", "step"))
		again.WriteString(panicLines(later.Add(time.Duration(m)*time.Minute+time.Second), "nil map", "step"))
	}
	appendLog(t, path, again.String())
	look(t, w)
	next := raised(fe.takeCards())
	if len(next) != 1 || next[0].Key != first[0].Key {
		t.Fatalf("a day later: %v", cardKeys(next))
	}
}

// AC11: an ignored signature raises nothing more, not even an update.
func TestAnIgnoredSignatureStaysQuiet(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, panicLines(day.Add(time.Minute), "nil map", "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	cards := fe.takeCards()
	if len(cards) != 1 {
		t.Fatalf("cards: %v", cardKeys(cards))
	}
	id := strings.TrimPrefix(cards[0].Key, CardKeyPrefix)
	if err := w.Mute(context.Background(), MuteRequest{Id: id}); err != nil {
		t.Fatal(err)
	}
	var spike strings.Builder
	for m := 3; m < 10; m++ {
		spike.WriteString(panicLines(day.Add(time.Duration(m)*time.Minute), "nil map", "step"))
		spike.WriteString(panicLines(day.Add(time.Duration(m)*time.Minute+time.Second), "nil map", "step"))
	}
	appendLog(t, path, spike.String())
	fe.advance(26 * time.Hour)
	look(t, w)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("an ignored signature published %v", cardKeys(cards))
	}
}

// Only what the log showed in the last day raises anything: the first look over an old log stays quiet.
func TestOldProblemsRaiseNothing(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	appendLog(t, path, panicLines(day.Add(-48*time.Hour), "nil map", "step"))
	look(t, w)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("an old panic raised %v", cardKeys(cards))
	}
}

// The usual rate: a signature known for an hour that comes ten times faster in one look spikes, even within a minute.
func TestTenTimesTheUsualRateIsASpike(t *testing.T) {
	t.Parallel()
	var s State
	rec := func(at time.Time) Record {
		return Record{Kind: KindError, At: at, Head: "[wavesrv] error: x", Pattern: normalise("[wavesrv] error: x")}
	}
	var history []Record
	for m := 0; m <= 70; m += 10 {
		history = append(history, rec(day.Add(time.Duration(m)*time.Minute)))
	}
	f := s.ingest(history, makeMasker(fakeHome))
	if ops := s.decide(f, day.Add(71*time.Minute)); len(ops) != 0 {
		t.Fatalf("the history raised %+v", ops)
	}
	var burst []Record
	for i := 0; i < 12; i++ {
		burst = append(burst, rec(day.Add(80*time.Minute+time.Duration(i)*time.Second)))
	}
	f = s.ingest(burst, makeMasker(fakeHome))
	ops := s.decide(f, day.Add(81*time.Minute))
	if len(ops) != 1 || !ops[0].raise || s.Signatures[0].Event != EventSpike {
		t.Fatalf("ops %+v, signature %+v", ops, s.Signatures[0])
	}
}

// AC6: a log that grows past 50 MB in an hour raises one card, brought up to date while open, and not when ignored.
func TestAFastGrowingLogRaisesOneCard(t *testing.T) {
	t.Parallel()
	var s State
	now := day.Add(2 * time.Hour)
	s.addBytes(now.Add(-2*time.Hour), 40<<20)
	s.addBytes(now.Add(-30*time.Minute), 30<<20)
	if ops := s.decide(lookFacts{}, now); len(ops) != 0 {
		t.Fatalf("30 MB in the hour raised %+v", ops)
	}
	s.addBytes(now.Add(-10*time.Minute), 30<<20)
	ops := s.decide(lookFacts{}, now)
	if len(ops) != 1 || ops[0].id != GrowthId || !ops[0].raise || s.Growth.Bytes != 60<<20 {
		t.Fatalf("ops %+v, growth %+v", ops, s.Growth)
	}
	s.addBytes(now.Add(5*time.Minute), 1<<20)
	ops = s.decide(lookFacts{}, now.Add(10*time.Minute))
	if len(ops) != 1 || ops[0].raise {
		t.Fatalf("the same hour: %+v", ops)
	}
	card := growthCard(s.Growth, cardFacts{logPath: "/data/waveapp.log", now: now, loc: time.UTC}, true)
	if card.Message != "61 MB written in the last hour: something may be repeating." || !card.Quiet || !card.RefreshOnly {
		t.Fatalf("card %+v", card)
	}
	s.Muted = map[string]int64{GrowthId: 1}
	s.addBytes(now.Add(26*time.Hour), 60<<20)
	if ops := s.decide(lookFacts{}, now.Add(26*time.Hour)); len(ops) != 0 {
		t.Fatalf("an ignored growth raised %+v", ops)
	}
}

// AC5: at most 200 signatures, the one seen longest ago dropped first; at most 500 ignored ones, the oldest first.
func TestTheStoreIsBounded(t *testing.T) {
	t.Parallel()
	var s State
	var recs []Record
	for i := 0; i < 250; i++ {
		head := fmt.Sprintf("[wavesrv] error: case %c%c", 'a'+i%26, 'a'+i/26)
		recs = append(recs, Record{Kind: KindError, At: day.Add(time.Duration(i) * time.Second), Head: head, Pattern: normalise(head)})
	}
	s.ingest(recs, makeMasker(fakeHome))
	s.Muted = map[string]int64{}
	for i := 0; i < 600; i++ {
		s.Muted[fmt.Sprintf("id%03d", i)] = int64(i)
	}
	s.prune(day.Add(time.Hour))
	if len(s.Signatures) != MaxSignatures || s.Signatures[0].Pattern != recs[249].Pattern {
		t.Fatalf("%d signatures, newest %q", len(s.Signatures), s.Signatures[0].Pattern)
	}
	for _, sig := range s.Signatures {
		if sig.Pattern == recs[0].Pattern {
			t.Fatal("the oldest signature was kept")
		}
	}
	if _, ok := s.Muted["id099"]; len(s.Muted) != MaxMuted || ok {
		t.Fatalf("%d muted, the oldest kept: %v", len(s.Muted), ok)
	}
}

// The state is kept in MoltenTerm's data: another watcher (a restart) goes on from where the last one stopped and does
// not raise again what it already raised.
func TestARestartGoesOnFromTheKeptState(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	appendLog(t, path, panicLines(day.Add(time.Minute), "nil map", "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	if len(fe.takeCards()) != 1 {
		t.Fatal("no first card")
	}
	again := MakeWatcher(w.env)
	look(t, again)
	if cards := fe.takeCards(); len(cards) != 0 {
		t.Fatalf("a restart published %v", cardKeys(cards))
	}
	info, err := os.Stat(statePath(w.env.DataDir))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", info, err)
	}
	if again.state.Signatures[0].Count != 1 {
		t.Fatalf("the restart read the log again: %+v", again.state.Signatures[0])
	}
}

// AC1: with the switch off nothing reads the log; switched on again, the watch resumes from where it stopped.
func TestTheSwitchOffReadsNothingAndTheWatchResumes(t *testing.T) {
	t.Parallel()
	w, fe, path := makeTestWatcher(t)
	look(t, w)
	fe.setEnabled(false)
	appendLog(t, path, panicLines(day.Add(time.Minute), "nil map", "step"))
	fe.advance(2 * time.Minute)
	look(t, w)
	before := w.state.File.Offset
	if cards := fe.takeCards(); len(cards) != 0 || before != 0 {
		t.Fatalf("switched off: %v, offset %d", cardKeys(cards), before)
	}
	fe.setEnabled(true)
	look(t, w)
	if cards := fe.takeCards(); len(raised(cards)) != 1 {
		t.Fatalf("switched on again: %v", cardKeys(cards))
	}
}
