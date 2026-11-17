// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentuse

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The clock of these tests is a number: nothing here waits, whatever the load of the machine.
var epoch = time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)

func at(d time.Duration) time.Time { return epoch.Add(d) }

func working(block string, agent string) Run {
	return Run{BlockId: block, Agent: agent, Started: epoch.UnixMilli(), Working: true}
}

func idle(block string, agent string) Run {
	return Run{BlockId: block, Agent: agent, Started: epoch.UnixMilli()}
}

func TestWorkingTimeIsCreditedBetweenTwoSamples(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{working("b1", "claude")})
	r.Sample(at(20*time.Second), []Run{working("b1", "claude")})
	r.Sample(at(40*time.Second), []Run{idle("b1", "claude")})
	r.Sample(at(60*time.Second), []Run{idle("b1", "claude")})
	got := r.Summary(at(time.Minute)).Agents["claude"]
	if got.WorkMs != 20_000 {
		t.Errorf("the working time is %d ms, want 20000 (only the sample that found the agent working earns the time since the last one)", got.WorkMs)
	}
	if got.Sessions != 1 {
		t.Errorf("sessions: %d, want 1", got.Sessions)
	}
}

func TestTheFirstSampleCreditsNothing(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{working("b1", "claude")})
	got := r.Summary(at(0)).Agents["claude"]
	if got.WorkMs != 0 || got.Sessions != 1 {
		t.Errorf("first sample: %+v, want no time and one session", got)
	}
}

func TestAGapLongerThanThreeSamplesIsNotCredited(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{working("b1", "claude")})
	// The computer slept for an hour.
	r.Sample(at(time.Hour), []Run{working("b1", "claude")})
	r.Sample(at(time.Hour+20*time.Second), []Run{working("b1", "claude")})
	got := r.Summary(at(time.Hour + 20*time.Second)).Agents["claude"]
	if got.WorkMs != 20_000 {
		t.Errorf("the working time is %d ms, want 20000: the sleep earns nothing", got.WorkMs)
	}
}

func TestARunIsOneSessionWhateverItsSamples(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	for i := 0; i < 5; i++ {
		r.Sample(at(time.Duration(i)*20*time.Second), []Run{idle("b1", "claude")})
	}
	if got := r.Summary(at(time.Minute)).Agents["claude"].Sessions; got != 1 {
		t.Errorf("sessions: %d, want 1", got)
	}
	again := Run{BlockId: "b1", Agent: "claude", Started: epoch.UnixMilli() + 1}
	r.Sample(at(2*time.Minute), []Run{again})
	if got := r.Summary(at(2 * time.Minute)).Agents["claude"].Sessions; got != 2 {
		t.Errorf("a new run in the same block: %d sessions, want 2", got)
	}
}

func TestEachAgentHasItsOwnUse(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	runs := []Run{working("b1", "claude"), idle("b2", "codex"), {BlockId: "b3", Started: 1, Working: true}}
	r.Sample(at(0), runs)
	r.Sample(at(20*time.Second), runs)
	sum := r.Summary(at(20 * time.Second))
	if sum.Agents["claude"].WorkMs != 20_000 || sum.Agents["codex"].WorkMs != 0 || sum.Agents["codex"].Sessions != 1 {
		t.Errorf("summary: %+v", sum.Agents)
	}
	if len(sum.Agents) != 2 {
		t.Errorf("a run with no agent id is not recorded: %+v", sum.Agents)
	}
}

func TestOnlyTheLastSevenDaysCount(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{idle("b1", "claude")})
	day := 24 * time.Hour
	if got := r.Summary(at(6 * day)).Agents["claude"]; got.Sessions != 1 {
		t.Errorf("after 6 days: %+v, want the session", got)
	}
	if _, ok := r.Summary(at(8 * day)).Agents["claude"]; ok {
		t.Errorf("after 8 days the agent is still counted as used")
	}
}

func TestLastUseIsTheLatestMomentOfWorkOrStart(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{idle("b1", "claude")})
	r.Sample(at(20*time.Second), []Run{working("b1", "claude")})
	r.Sample(at(40*time.Second), []Run{idle("b1", "claude")})
	if got, want := r.Summary(at(time.Minute)).Agents["claude"].LastAt, at(20*time.Second).UnixMilli(); got != want {
		t.Errorf("last use %d, want %d", got, want)
	}
}

func TestOldHoursAreTrimmed(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{idle("b1", "claude")})
	r.Sample(at(9*24*time.Hour), nil)
	file := r.Take()
	if file == nil {
		t.Fatal("the record changed and was not offered for writing")
	}
	if len(file.Agents) != 0 {
		t.Errorf("hours older than 8 days are kept: %+v", file.Agents)
	}
}

func TestTakeOffersOnlyWhatChanged(t *testing.T) {
	t.Parallel()
	r := MakeRecorder()
	r.Sample(at(0), []Run{idle("b1", "claude")})
	if r.Take() == nil {
		t.Fatal("a new session is a change")
	}
	r.Sample(at(20*time.Second), []Run{idle("b1", "claude")})
	if r.Take() != nil {
		t.Errorf("an idle sample changed nothing, yet the record is offered again")
	}
}

func TestTheRecordSurvivesARestart(t *testing.T) {
	t.Parallel()
	store := MakeStore(filepath.Join(t.TempDir(), "agentuse"))
	first := MakeRecorder()
	first.Sample(at(0), []Run{working("b1", "claude")})
	first.Sample(at(20*time.Second), []Run{working("b1", "claude")})
	if err := store.Save(first.Take()); err != nil {
		t.Fatal(err)
	}
	second := MakeRecorder()
	file, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	second.Restore(file)
	got := second.Summary(at(time.Minute)).Agents["claude"]
	if got.WorkMs != 20_000 || got.Sessions != 1 {
		t.Errorf("after the restart: %+v, want 20 s and one session", got)
	}
}

func TestACorruptRecordIsSetAsideAndHoldsNothing(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := MakeStore(dir).Load()
	if err != nil || len(file.Agents) != 0 {
		t.Fatalf("load: %+v, %v", file, err)
	}
	if _, err := os.Stat(filepath.Join(dir, fileName+corruptMark)); err != nil {
		t.Errorf("the corrupt file was not set aside: %v", err)
	}
}

func TestARecordWithoutAFileHoldsNothing(t *testing.T) {
	t.Parallel()
	file, err := MakeStore(filepath.Join(t.TempDir(), "none")).Load()
	if err != nil || len(file.Agents) != 0 {
		t.Fatalf("load: %+v, %v", file, err)
	}
}

func TestTheRecordHoldsNumbersOnly(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	r := MakeRecorder()
	r.Sample(at(0), []Run{{BlockId: "block-with-a-secret-name", Agent: "claude", Started: 5, Working: true}})
	r.Sample(at(20*time.Second), []Run{{BlockId: "block-with-a-secret-name", Agent: "claude", Started: 5, Working: true}})
	store := MakeStore(dir)
	if err := store.Save(r.Take()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 || strings.Contains(string(raw), "block-with-a-secret-name") {
		t.Errorf("the file is empty or names a block: %s", raw)
	}
	info, err := os.Stat(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != fileMode {
		t.Errorf("file mode %v, want %v", info.Mode().Perm(), os.FileMode(fileMode))
	}
}
