// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Monday 16 November 2026, 09:00 UTC: every moment of these tests is read off this one, so none depends on the clock.
var historyBase = time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)

func newTestHistory(t *testing.T) (*usageHistory, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "history")
	return makeUsageHistory(func() string { return dir }, time.UTC), dir
}

// sessionReading is a plan with a session and a week: what Claude Code's status line gives.
func sessionReading(agent string, sessionUsed, weekUsed float64, sessionReset, weekReset, readAt time.Time) UsageSnapshot {
	return UsageSnapshot{Agent: agent, ReadAt: readAt.UnixMilli(), Windows: []UsageWindow{
		{Id: WindowSession, UsedPercent: sessionUsed, ResetsAt: sessionReset.UnixMilli(), WindowMins: fiveHourMins},
		{Id: WindowWeek, UsedPercent: weekUsed, ResetsAt: weekReset.UnixMilli(), WindowMins: sevenDayMins},
	}}
}

// historyLines reads a provider's file back: one JSON object per line.
func historyLines(t *testing.T, dir, agent string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, agent+historyExt))
	if err != nil {
		t.Fatalf("the history of %s: %v", agent, err)
	}
	var rtn []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("a line of the history of %s is no JSON object: %q", agent, line)
		}
		rtn = append(rtn, record)
	}
	return rtn
}

func kinds(lines []map[string]any, kind string) []map[string]any {
	var rtn []map[string]any
	for _, l := range lines {
		if l["kind"] == kind {
			rtn = append(rtn, l)
		}
	}
	return rtn
}

// record keeps a reading at the moment it was read.
func (h *usageHistory) recordAt(agent string, snap UsageSnapshot) {
	h.Record(agent, snap, time.UnixMilli(snap.ReadAt))
}

func TestHistoryKeepsEveryReadingOfEveryProviderInItsOwnFile(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	for i, agent := range []string{"claude", "codex", "kimi"} {
		h.recordAt(agent, sessionReading(agent, float64(10+i), float64(20+i), historyBase.Add(5*time.Hour), week, historyBase))
	}
	h.recordAt("claude", sessionReading("claude", 12, 21, historyBase.Add(5*time.Hour), week, historyBase.Add(time.Minute)))
	for agent, want := range map[string]int{"claude": 2, "codex": 1, "kimi": 1} {
		lines := historyLines(t, dir, agent)
		if len(lines) != want {
			t.Errorf("%s keeps %d readings, want %d", agent, len(lines), want)
		}
	}
	first := historyLines(t, dir, "claude")[0]
	windows := first["windows"].([]any)
	session := windows[0].(map[string]any)
	if first["kind"] != recordReading || session["id"] != WindowSession || session["used"] != 10.0 ||
		session["resetsat"] != float64(historyBase.Add(5*time.Hour).UnixMilli()) || session["mins"] != 300.0 {
		t.Errorf("a reading keeps the windows, their used percent, reset time and length: %v", first)
	}
	info, err := os.Stat(filepath.Join(dir, "claude"+historyExt))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the history is the user's only: %v %v", info, err)
	}
	for _, agent := range []string{"", "../claude", "a/b"} {
		h.recordAt(agent, sessionReading("x", 1, 1, historyBase.Add(time.Hour), week, historyBase))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Errorf("an id that could name another place keeps nothing: %v", entries)
	}
}

func TestHistoryStoresAReadingWhenAWindowChangesOrAfterTheHeartbeat(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 10, 20, session, week, historyBase))
	// The same windows again, a minute later, nine minutes later: nothing new.
	h.recordAt("claude", sessionReading("claude", 10, 20, session, week, historyBase.Add(time.Minute)))
	h.recordAt("claude", sessionReading("claude", 10, 20, session, week, historyBase.Add(historyHeartbeat-time.Minute)))
	if n := len(historyLines(t, dir, "claude")); n != 1 {
		t.Fatalf("a reading that says what the last said stays one: %d", n)
	}
	// Ten minutes on, a quiet stretch keeps a point.
	h.recordAt("claude", sessionReading("claude", 10, 20, session, week, historyBase.Add(historyHeartbeat)))
	if n := len(historyLines(t, dir, "claude")); n != 2 {
		t.Fatalf("a quiet stretch keeps a point every ten minutes: %d", n)
	}
	h.recordAt("claude", sessionReading("claude", 10.5, 20, session, week, historyBase.Add(historyHeartbeat+time.Minute)))
	if n := len(historyLines(t, dir, "claude")); n != 3 {
		t.Fatalf("a window that moved is a new reading: %d", n)
	}
}

func TestHistoryKeepsNoReadingTheSourceKeptNorWindowsPastTheirReset(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	kept := sessionReading("kimi", 10, 20, historyBase.Add(5*time.Hour), week, historyBase)
	kept.Stale = ReasonTokenExpired
	h.recordAt("kimi", kept)
	if _, err := os.Stat(filepath.Join(dir, "kimi"+historyExt)); err == nil {
		t.Fatal("a reading kept because no fresh one could be read is no reading")
	}
	past := sessionReading("claude", 10, 20, historyBase.Add(-time.Minute), week, historyBase)
	h.recordAt("claude", past)
	lines := historyLines(t, dir, "claude")
	windows := lines[0]["windows"].([]any)
	if len(lines) != 1 || len(windows) != 1 || windows[0].(map[string]any)["id"] != WindowWeek {
		t.Errorf("a window past its reset is not a reading of it: %v", lines)
	}
}

func TestHistorySurvivesARestart(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 5, 10, session, week, historyBase))
	h.recordAt("claude", sessionReading("claude", 100, 14, session, week, historyBase.Add(4*time.Hour)))
	restarted := makeUsageHistory(func() string { return dir }, time.UTC)
	snap := sessionReading("claude", 3, 14, session.Add(5*time.Hour), week, historyBase.Add(6*time.Hour))
	restarted.Note("claude", &snap, historyBase.Add(6*time.Hour))
	if got := windowById(snap, WindowWeek).SessionWorth; got != 4.21 {
		t.Errorf("the worth measured before the restart is read back: %v", got)
	}
	// The running week was read back too: its reset is told once, whatever the restarts.
	after := week.Add(time.Hour)
	next := sessionReading("claude", 1, 0.5, after.Add(5*time.Hour), week.Add(7*24*time.Hour), after)
	restarted.recordAt("claude", next)
	again := makeUsageHistory(func() string { return dir }, time.UTC)
	again.recordAt("claude", sessionReading("claude", 2, 0.6, after.Add(5*time.Hour), week.Add(7*24*time.Hour), after.Add(time.Minute)))
	if n := len(kinds(historyLines(t, dir, "claude"), recordReset)); n != 1 {
		t.Errorf("one reset, one record: %d", n)
	}
}

func TestHistoryBoundsItsReadings(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(30 * 24 * time.Hour)
	session := historyBase.Add(30 * 24 * time.Hour)
	total := historyKeepReadings + historySlack + 200
	for i := 0; i < total; i++ {
		at := historyBase.Add(time.Duration(i) * time.Minute)
		h.recordAt("claude", sessionReading("claude", float64(i%100), float64(i)/1000, session, week, at))
	}
	readings := kinds(historyLines(t, dir, "claude"), recordReading)
	if len(readings) > historyKeepReadings+historySlack || len(readings) < historyKeepReadings {
		t.Fatalf("the readings stay within their bound: %d", len(readings))
	}
	h.lock.Lock()
	inMemory := len(h.agents["claude"].readings)
	h.lock.Unlock()
	if inMemory != len(readings) {
		t.Errorf("the file and the memory hold the same readings: %d, %d", len(readings), inMemory)
	}
	last := readings[len(readings)-1]["at"].(float64)
	if int64(last) != historyBase.Add(time.Duration(total-1)*time.Minute).UnixMilli() {
		t.Error("the newest stay")
	}
	first := readings[0]["at"].(float64)
	if int64(first) == historyBase.UnixMilli() {
		t.Error("the oldest go first")
	}
}

func TestHistoryDropsReadingsOlderThanItsAge(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	old := historyBase.Add(-historyKeepAge - 24*time.Hour)
	h.Record("claude", sessionReading("claude", 10, 20, old.Add(time.Hour), old.Add(24*time.Hour), old), old)
	h.recordAt("claude", sessionReading("claude", 11, 21, historyBase.Add(5*time.Hour), week, historyBase))
	lines := historyLines(t, dir, "claude")
	if len(kinds(lines, recordReading)) != 1 {
		t.Errorf("a reading older than its age is dropped: %v", lines)
	}
}

func TestHistoryBoundsItsMeasuresAndResets(t *testing.T) {
	h, dir := newTestHistory(t)
	h.lock.Lock()
	p := h.providerLocked("claude", historyBase)
	for i := 0; i < historyKeepWorths+50; i++ {
		p.worths = append(p.worths, historyWorth{Kind: recordWorth, At: historyBase.UnixMilli(), Window: WindowWeek, Worth: 1})
	}
	for i := 0; i < historyKeepResets+50; i++ {
		p.resets = append(p.resets, historyReset{Kind: recordReset, Window: WindowWeek, End: int64(i)})
	}
	h.pruneLocked(p, historyBase)
	h.rewriteLocked(p)
	h.lock.Unlock()
	lines := historyLines(t, dir, "claude")
	if len(kinds(lines, recordWorth)) != historyKeepWorths || len(kinds(lines, recordReset)) != historyKeepResets {
		t.Errorf("measures and resets keep their count: %d, %d", len(kinds(lines, recordWorth)), len(kinds(lines, recordReset)))
	}
	if kinds(lines, recordReset)[0]["end"] != 50.0 {
		t.Error("the oldest resets go first")
	}
}

func TestHistoryStartsEmptyOnAFileItCannotRead(t *testing.T) {
	h, dir := newTestHistory(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "claude"+historyExt)
	if err := os.WriteFile(path, []byte("not json\n{\"kind\":\"alien\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	week := historyBase.Add(3 * 24 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 10, 20, historyBase.Add(5*time.Hour), week, historyBase))
	lines := historyLines(t, dir, "claude")
	if len(lines) != 1 || lines[0]["kind"] != recordReading {
		t.Errorf("what is not the history is dropped, the file written again: %v", lines)
	}
	big := filepath.Join(dir, "codex"+historyExt)
	if err := os.WriteFile(big, make([]byte, historyMaxBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	h.recordAt("codex", sessionReading("codex", 10, 20, historyBase.Add(5*time.Hour), week, historyBase))
	if n := len(historyLines(t, dir, "codex")); n != 1 {
		t.Errorf("a file too large to read is replaced, not appended to: %d lines", n)
	}
}

// ---- the session's worth ----

// fullSession plays a session from its start to its end, the week rising by `rise` points over it, and returns the
// moment after it. Claude's week resets on `week`.
func fullSession(h *usageHistory, agent string, start time.Time, weekFrom, rise float64, week time.Time) time.Time {
	session := start.Add(5 * time.Hour)
	h.recordAt(agent, sessionReading(agent, 5, weekFrom, session, week, start))
	h.recordAt(agent, sessionReading(agent, 40, weekFrom+rise*0.4, session, week, start.Add(time.Hour)))
	h.recordAt(agent, sessionReading(agent, 75, weekFrom+rise*0.8, session, week, start.Add(2*time.Hour)))
	h.recordAt(agent, sessionReading(agent, 100, weekFrom+rise, session, week, start.Add(4*time.Hour)))
	return session
}

func worthsOf(t *testing.T, dir, agent string) []map[string]any {
	t.Helper()
	return kinds(historyLines(t, dir, agent), recordWorth)
}

func TestWorthIsThePoolsRiseOverASessionSeenUsedInFull(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	// The session went from 5 % to 100 % (95 points) while the week rose from 10 % to 13.8 %: 4 % of the week per session.
	session := fullSession(h, "claude", historyBase, 10, 3.8, week)
	worths := worthsOf(t, dir, "claude")
	if len(worths) != 1 || worths[0]["window"] != WindowWeek || worths[0]["worth"] != 4.0 ||
		worths[0]["session"] != float64(session.UnixMilli()) || worths[0]["mins"] != 300.0 {
		t.Fatalf("one measure, on the week, with the session it came from: %v", worths)
	}
	// A reading with no session window, as Claude Code's status line gives between two responses, still tells it.
	snap := UsageSnapshot{Agent: "claude", Windows: []UsageWindow{
		{Id: WindowWeek, UsedPercent: 14, ResetsAt: week.UnixMilli(), WindowMins: sevenDayMins},
	}}
	h.Annotate("claude", &snap, session.Add(time.Hour))
	if got := windowById(snap, WindowWeek); got.SessionWorth != 4 || got.SessionMins != 300 {
		t.Errorf("the week tells what a session is worth, and how long a session is: %+v", got)
	}
	again := sessionReading("claude", 2, 14, session.Add(5*time.Hour), week, session.Add(time.Hour))
	h.Annotate("claude", &again, session.Add(time.Hour))
	if got := windowById(again, WindowSession); got.SessionWorth != 0 || got.SessionMins != 0 {
		t.Errorf("the session window carries no worth: %+v", got)
	}
}

func TestWorthOfAMonthIsMeasuredToo(t *testing.T) {
	h, dir := newTestHistory(t)
	month := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	session := historyBase.Add(5 * time.Hour)
	read := func(s, m float64, at time.Time) {
		h.recordAt("kimi", UsageSnapshot{Agent: "kimi", ReadAt: at.UnixMilli(), Windows: []UsageWindow{
			{Id: WindowSession, UsedPercent: s, ResetsAt: session.UnixMilli(), WindowMins: fiveHourMins},
			{Id: WindowMonth, UsedPercent: m, ResetsAt: month.UnixMilli()},
		}})
	}
	// The month rose from 10 % to 11.5 % over a full session: 1.5 % of the month per session.
	read(0, 10, historyBase)
	read(50, 10.75, historyBase.Add(2*time.Hour))
	read(100, 11.5, historyBase.Add(4*time.Hour))
	worths := worthsOf(t, dir, "kimi")
	if len(worths) != 1 || worths[0]["window"] != WindowMonth || worths[0]["worth"] != 1.5 {
		t.Errorf("a session worth in share of the month: %v", worths)
	}
}

func TestWorthIsNotMeasuredWithoutAFullSessionSeenFromItsStart(t *testing.T) {
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	cases := map[string][][3]float64{
		"a session first seen at 60 %":      {{60, 10, 0}, {100, 12, 4}},
		"a session never full":              {{5, 10, 0}, {50, 11, 2}, {98, 13, 4}},
		"a pool that did not rise":          {{5, 10, 0}, {100, 10, 4}},
		"a pool that went down":             {{5, 10, 0}, {100, 9, 4}},
		"a session at its start, only once": {{100, 10, 0}},
	}
	for name, readings := range cases {
		h, dir := newTestHistory(t)
		for _, r := range readings {
			h.recordAt("claude", sessionReading("claude", r[0], r[1], session, week, historyBase.Add(time.Duration(r[2])*time.Hour)))
		}
		if worths := worthsOf(t, dir, "claude"); len(worths) != 0 {
			t.Errorf("%s gives no worth: %v", name, worths)
		}
	}
}

func TestWorthIsNotMeasuredWhenThePoolResetsOverTheSession(t *testing.T) {
	h, dir := newTestHistory(t)
	session := historyBase.Add(5 * time.Hour)
	reset := historyBase.Add(2 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 5, 95, session, reset, historyBase))
	h.recordAt("claude", sessionReading("claude", 60, 2, session, reset.Add(7*24*time.Hour), historyBase.Add(3*time.Hour)))
	h.recordAt("claude", sessionReading("claude", 100, 8, session, reset.Add(7*24*time.Hour), historyBase.Add(4*time.Hour)))
	if worths := worthsOf(t, dir, "claude"); len(worths) != 0 {
		t.Errorf("a session cut by the pool's reset is not a measure: %v", worths)
	}
}

func TestWorthIsNeverMeasuredForAModelsWeek(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	read := func(s, w, m float64, at time.Time) {
		snap := sessionReading("claude", s, w, session, week, at)
		snap.Windows = append(snap.Windows, UsageWindow{Id: WindowModelPrefix + "opus", UsedPercent: m, ResetsAt: week.UnixMilli(), WindowMins: sevenDayMins})
		h.recordAt("claude", snap)
	}
	read(5, 10, 3, historyBase)
	read(100, 14, 9, historyBase.Add(4*time.Hour))
	worths := worthsOf(t, dir, "claude")
	if len(worths) != 1 || worths[0]["window"] != WindowWeek {
		t.Errorf("only the week and the month: %v", worths)
	}
	snap := sessionReading("claude", 2, 14, session.Add(5*time.Hour), week, historyBase.Add(5*time.Hour))
	snap.Windows = append(snap.Windows, UsageWindow{Id: WindowModelPrefix + "opus", UsedPercent: 9})
	h.Annotate("claude", &snap, historyBase.Add(5*time.Hour))
	if snap.Windows[2].SessionWorth != 0 {
		t.Error("a model's week carries no worth")
	}
}

func TestWorthIsTheMedianOfTheLastMeasuresAndForgetsTheOld(t *testing.T) {
	h, _ := newTestHistory(t)
	week := historyBase.Add(30 * 24 * time.Hour)
	at := historyBase
	for _, rise := range []float64{3, 4, 10, 5, 4} {
		fullSession(h, "claude", at, 10, rise, week)
		at = at.Add(6 * time.Hour)
	}
	snap := sessionReading("claude", 0, 50, at.Add(5*time.Hour), week, at)
	h.Annotate("claude", &snap, at)
	// The worths are 3.16, 4.21, 10.53, 5.26 and 4.21 (rise over 95 points): the median is 4.21.
	if got := windowById(snap, WindowWeek).SessionWorth; got != 4.21 {
		t.Errorf("the median of the last five: %v", got)
	}
	// Two measures: their mean.
	h2, _ := newTestHistory(t)
	fullSession(h2, "claude", historyBase, 10, 3, week)
	fullSession(h2, "claude", historyBase.Add(6*time.Hour), 20, 5, week)
	snap2 := sessionReading("claude", 0, 50, at.Add(5*time.Hour), week, at)
	h2.Annotate("claude", &snap2, at)
	if got := windowById(snap2, WindowWeek).SessionWorth; got != 4.21 {
		t.Errorf("the mean of two: %v", got)
	}
	// A measure older than 60 days is not used.
	later := at.Add(worthMaxAge + time.Hour)
	snap3 := sessionReading("claude", 0, 50, later.Add(5*time.Hour), week, later)
	h2.Annotate("claude", &snap3, later)
	if got := windowById(snap3, WindowWeek).SessionWorth; got != 0 {
		t.Errorf("an old measure is forgotten: %v", got)
	}
}

func TestTheWorthIsUnknownUntilMeasured(t *testing.T) {
	h, _ := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	snap := sessionReading("claude", 10, 20, historyBase.Add(5*time.Hour), week, historyBase)
	h.Note("claude", &snap, historyBase)
	if got := windowById(snap, WindowWeek).SessionWorth; got != 0 {
		t.Errorf("never a guess: %v", got)
	}
}

// ---- the reset of a pool window ----

func TestAResetRecordsTheWindowsDatesTheShareUsedAndTheShareLost(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 20, 62.5, session, week, historyBase))
	h.recordAt("claude", sessionReading("claude", 40, 62.5, session.Add(48*time.Hour), week, historyBase.Add(43*time.Hour)))
	if n := len(kinds(historyLines(t, dir, "claude"), recordReset)); n != 0 {
		t.Fatalf("nothing resets before its time: %d", n)
	}
	// The week resets; the new window has its first reading an hour later.
	after := week.Add(time.Hour)
	h.recordAt("claude", sessionReading("claude", 1, 0.4, after.Add(5*time.Hour), week.Add(7*24*time.Hour), after))
	h.recordAt("claude", sessionReading("claude", 3, 0.9, after.Add(5*time.Hour), week.Add(7*24*time.Hour), after.Add(time.Minute)))
	resets := kinds(historyLines(t, dir, "claude"), recordReset)
	if len(resets) != 1 {
		t.Fatalf("one record for the week that ended: %v", resets)
	}
	r := resets[0]
	if r["window"] != WindowWeek || r["start"] != float64(week.Add(-7*24*time.Hour).UnixMilli()) || r["end"] != float64(week.UnixMilli()) {
		t.Errorf("its dates: %v", r)
	}
	// 62.5 % used, 37.5 % left unused: 2.625 of its 7 days.
	if r["days"] != 7.0 || r["used"] != 62.5 || r["lost"] != 37.5 || r["lostdays"] != 2.63 {
		t.Errorf("the share used and the share lost, in percent and in days: %v", r)
	}
	if r["readat"] != float64(historyBase.Add(43*time.Hour).UnixMilli()) {
		t.Errorf("the reading it comes from: %v", r)
	}
}

func TestAMonthlyResetCountsTheDaysOfTheMonth(t *testing.T) {
	h, dir := newTestHistory(t)
	december := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	read := func(used float64, reset, at time.Time) {
		h.recordAt("kimi", UsageSnapshot{Agent: "kimi", ReadAt: at.UnixMilli(), Windows: []UsageWindow{
			{Id: WindowMonth, UsedPercent: used, ResetsAt: reset.UnixMilli()},
		}})
	}
	read(40, december, time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC))
	read(1, time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), december.Add(time.Hour))
	resets := kinds(historyLines(t, dir, "kimi"), recordReset)
	if len(resets) != 1 {
		t.Fatalf("one record: %v", resets)
	}
	r := resets[0]
	// November has 30 days: 60 % unused is 18 of them.
	if r["window"] != WindowMonth || r["days"] != 30.0 || r["used"] != 40.0 || r["lost"] != 60.0 || r["lostdays"] != 18.0 ||
		r["start"] != float64(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Errorf("a month's reset: %v", r)
	}
}

func TestAResetIsToldWhenTheProviderDropsTheWindowAfterIt(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 20, 80, historyBase.Add(5*time.Hour), week, historyBase))
	// Claude Code's status line gives no week until its next response after the reset: only the session shows.
	late := week.Add(2 * time.Hour)
	h.recordAt("claude", UsageSnapshot{Agent: "claude", ReadAt: late.UnixMilli(), Windows: []UsageWindow{
		{Id: WindowSession, UsedPercent: 2, ResetsAt: late.Add(4 * time.Hour).UnixMilli(), WindowMins: fiveHourMins},
	}})
	resets := kinds(historyLines(t, dir, "claude"), recordReset)
	if len(resets) != 1 || resets[0]["used"] != 80.0 || resets[0]["lost"] != 20.0 {
		t.Errorf("the week that ended is told: %v", resets)
	}
}

func TestOnlyPoolWindowsAreClosedAtAReset(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	session := historyBase.Add(5 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 20, 80, session, week, historyBase))
	h.recordAt("claude", sessionReading("claude", 1, 80, session.Add(5*time.Hour), week, session.Add(time.Minute)))
	if n := len(kinds(historyLines(t, dir, "claude"), recordReset)); n != 0 {
		t.Errorf("a session ending is no global reset: %d", n)
	}
}

// ---- the gauges turned off ----

func TestTurningTheGaugesOffClearsTheHistoryOfThatAgentOnly(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	for _, agent := range []string{"claude", "codex"} {
		h.recordAt(agent, sessionReading(agent, 10, 20, historyBase.Add(5*time.Hour), week, historyBase))
	}
	exists := func(agent string) bool {
		_, err := os.Stat(filepath.Join(dir, agent+historyExt))
		return err == nil
	}
	h.Sync("claude", true)
	if !exists("claude") {
		t.Fatal("an unrelated change of settings never wipes the history")
	}
	h.Sync("claude", false)
	if exists("claude") || !exists("codex") {
		t.Fatalf("claude's history goes, codex's stays: %v %v", exists("claude"), exists("codex"))
	}
	h.recordAt("claude", sessionReading("claude", 11, 21, historyBase.Add(5*time.Hour), week, historyBase.Add(time.Minute)))
	if lines := historyLines(t, dir, "claude"); len(lines) != 1 {
		t.Errorf("it starts again from nothing: %v", lines)
	}
}

func TestTheHistoryOfAnAgentWhoseGaugesWereNeverSeenOnIsKept(t *testing.T) {
	h, dir := newTestHistory(t)
	week := historyBase.Add(3 * 24 * time.Hour)
	h.recordAt("claude", sessionReading("claude", 10, 20, historyBase.Add(5*time.Hour), week, historyBase))
	// MoltenTerm starting with the gauges off: nothing says they were on, so nothing goes.
	restarted := makeUsageHistory(func() string { return dir }, time.UTC)
	restarted.Sync("claude", false)
	restarted.Sync("claude", false)
	if _, err := os.Stat(filepath.Join(dir, "claude"+historyExt)); err != nil {
		t.Fatalf("a history never seen on is not deleted: %v", err)
	}
	restarted.Sync("claude", true)
	restarted.Sync("claude", false)
	if _, err := os.Stat(filepath.Join(dir, "claude"+historyExt)); err == nil {
		t.Fatal("on to off deletes it")
	}
}

func TestHidingTheUsageClearsTheHistoryWhateverTheState(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(UseHistoryForTest(dir, time.UTC))
	week := historyBase.Add(3 * 24 * time.Hour)
	defaultHistory.recordAt("claude", sessionReading("claude", 10, 20, historyBase.Add(5*time.Hour), week, historyBase))
	ClearValues(&pageAdapter{id: "claude"})
	if _, err := os.Stat(filepath.Join(dir, "claude"+historyExt)); err == nil {
		t.Error("hide plan usage deletes the history (NFR-SHELL-011)")
	}
}

// ---- the readings of every source go through ReadGauges ----

func TestReadGaugesKeepsTheReadingsAndTellsTheWorth(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(UseHistoryForTest(dir, time.UTC))
	week := historyBase.Add(3 * 24 * time.Hour)
	src := &fakeSource{id: "fake", enabled: true}
	a := &pageAdapter{id: "claude", sources: []GaugesSource{src}}
	read := func(sessionUsed, weekUsed float64, at time.Time, sessionReset time.Time) GaugesResult {
		src.snap = sessionReading("claude", sessionUsed, weekUsed, sessionReset, week, at)
		return ReadGauges(context.Background(), a, &wconfig.SettingsType{}, "b1", at.UnixMilli())
	}
	session := historyBase.Add(5 * time.Hour)
	read(5, 10, historyBase, session)
	read(60, 12, historyBase.Add(2*time.Hour), session)
	res := read(100, 13.8, historyBase.Add(4*time.Hour), session)
	if len(kinds(historyLines(t, dir, "claude"), recordReading)) != 3 {
		t.Errorf("every reading is kept: %v", historyLines(t, dir, "claude"))
	}
	if got := windowById(*res.Snapshot, WindowWeek).SessionWorth; got != 4 {
		t.Errorf("the reading that completes a session already tells its worth: %v", got)
	}
	next := read(1, 14, historyBase.Add(6*time.Hour), historyBase.Add(11*time.Hour))
	if got := windowById(*next.Snapshot, WindowWeek).SessionWorth; got != 4 {
		t.Errorf("the worth stays on the readings that follow: %v", got)
	}
	if got := windowById(*next.Snapshot, WindowSession).SessionWorth; got != 0 {
		t.Errorf("the session window carries none: %v", got)
	}
}
