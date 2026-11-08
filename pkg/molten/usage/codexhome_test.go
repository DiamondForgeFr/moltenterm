// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A Pro Lite record as Codex 0.166 writes it: one weekly primary window, no secondary, no credits balance.
func proLiteLine(at time.Time, percent float64, resets time.Time) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}},`+
		`"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":%g,"window_minutes":10080,"resets_at":%d},`+
		`"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,`+
		`"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}}}`,
		at.UTC().Format(time.RFC3339Nano), percent, resets.Unix())
}

const conversationLine = `{"timestamp":"2026-11-06T00:00:00Z","type":"response_item","payload":{"type":"message","content":"secret words"}}`

func writeRollout(t *testing.T, home string, rel string, modified time.Time, lines ...string) string {
	t.Helper()
	path := filepath.Join(home, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

func homeUsage(now time.Time, fake *fakeAppServer) *CodexUsage {
	clock := &codexClock{at: now}
	var run CodexAppServerRun
	if fake != nil {
		run = fake.run
	}
	cu := MakeCodexUsage(run)
	cu.now = clock.now
	return cu
}

func TestCodexHomeProLiteWithoutSecondary(t *testing.T) {
	t.Parallel()
	now := time.Now()
	home := t.TempDir()
	writeRollout(t, home, "sessions/2026/11/02/rollout-a.jsonl", now.Add(-time.Minute),
		conversationLine, proLiteLine(now.Add(-10*time.Minute), 9, now.Add(4*24*time.Hour)), conversationLine)
	snap, err := homeUsage(now, nil).ReadGlobal(context.Background(), home)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Plan != "prolite" || len(snap.Windows) != 1 || snap.Windows[0].Id != WindowWeek || snap.Windows[0].UsedPercent != 9 {
		t.Fatalf("%+v", snap)
	}
	if snap.Windows[0].ResetsAt == 0 || snap.ReadAt != now.Add(-10*time.Minute).UnixMilli() {
		t.Fatalf("reset or age lost: %+v", snap)
	}
}

func TestCodexHomeNewestRolloutWins(t *testing.T) {
	t.Parallel()
	now := time.Now()
	home := t.TempDir()
	resets := now.Add(3 * 24 * time.Hour)
	// A session started days ago and resumed today keeps its first day's folder: the record's time decides.
	writeRollout(t, home, "sessions/2026/11/02/rollout-old-folder.jsonl", now.Add(-2*time.Minute),
		proLiteLine(now.Add(-5*time.Minute), 40, resets))
	writeRollout(t, home, "sessions/2026/11/07/rollout-new-folder.jsonl", now.Add(-3*time.Hour),
		proLiteLine(now.Add(-3*time.Hour), 20, resets))
	writeRollout(t, home, "archived_sessions/rollout-archived.jsonl", now.Add(-48*time.Hour),
		proLiteLine(now.Add(-48*time.Hour), 5, resets))
	snap, err := homeUsage(now, nil).ReadGlobal(context.Background(), home)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Windows[0].UsedPercent != 40 {
		t.Fatalf("got %g, want the newest record's 40", snap.Windows[0].UsedPercent)
	}
}

func TestCodexHomeReadsOnlyTheTail(t *testing.T) {
	t.Parallel()
	now := time.Now()
	resets := now.Add(3 * 24 * time.Hour)
	filler := `{"timestamp":"2026-11-06T00:00:00Z","type":"response_item","payload":{"type":"message","content":"` +
		strings.Repeat("x", 1024*1024) + `"}}`
	lines := []string{proLiteLine(now.Add(-time.Hour), 77, resets)}
	for range 9 {
		lines = append(lines, filler)
	}
	lines = append(lines, proLiteLine(now.Add(-time.Minute), 12, resets))
	home := t.TempDir()
	writeRollout(t, home, "sessions/2026/11/06/rollout-big.jsonl", now, lines...)
	lim, ok := ReadCodexHomeLimits(home)
	if !ok || len(lim.Records) != 1 {
		t.Fatalf("%v %+v", ok, lim)
	}
	if got := looseObject(lim.Records[0].RateLimits, "primary")["used_percent"]; got != 12.0 {
		t.Fatalf("got %v from beyond the tail", got)
	}
}

func TestCodexHomeAppServerFallback(t *testing.T) {
	t.Parallel()
	now := time.Now()
	home := t.TempDir()
	writeRollout(t, home, "sessions/2026/11/06/rollout-a.jsonl", now, conversationLine)
	fake := &fakeAppServer{result: appServerResult}
	cu := homeUsage(now, fake)
	// The automatic reads start no process.
	if _, err := cu.ReadGlobal(WithoutProcess(WithFetch(context.Background(), true)), home); err == nil || fake.count() != 0 {
		t.Fatalf("a read without process ran the app-server: %v, %d", err, fake.count())
	}
	snap, err := cu.ReadGlobal(WithFetch(context.Background(), true), home)
	if err != nil || snap.Source != CodexAppServerSourceId || snap.Windows[0].UsedPercent != 33 || fake.count() != 1 {
		t.Fatalf("%+v %v %d", snap, err, fake.count())
	}
	// Its value holds: no second process.
	if _, err := cu.ReadGlobal(WithFetch(context.Background(), true), home); err != nil || fake.count() != 1 {
		t.Fatalf("%v %d", err, fake.count())
	}
}

func TestCodexHomeOldReadingShowsWithItsAge(t *testing.T) {
	t.Parallel()
	now := time.Now()
	home := t.TempDir()
	at := now.Add(-26 * time.Hour)
	writeRollout(t, home, "sessions/2026/11/06/rollout-a.jsonl", at, proLiteLine(at, 9, now.Add(3*24*time.Hour)))
	fake := &fakeAppServer{err: Unavailable(ReasonFailed)}
	snap, err := homeUsage(now, fake).ReadGlobal(WithFetch(context.Background(), true), home)
	if err != nil || snap.ReadAt != at.UnixMilli() || snap.Windows[0].UsedPercent != 9 {
		t.Fatalf("%+v %v", snap, err)
	}
	if fake.count() != 1 {
		t.Fatalf("an old reading asks the app-server for a fresher one: %d", fake.count())
	}
}

func TestCodexHomeUnreadable(t *testing.T) {
	t.Parallel()
	now := time.Now()
	home := t.TempDir()
	at := now.Add(-9 * 24 * time.Hour)
	writeRollout(t, home, "sessions/2026/10/29/rollout-a.jsonl", at, proLiteLine(at, 9, now.Add(-2*24*time.Hour)))
	if _, err := homeUsage(now, nil).ReadGlobal(WithoutProcess(context.Background()), home); ReasonOf(err) != ReasonExpired {
		t.Fatalf("past its reset: %v", err)
	}
	if _, ok := ReadCodexHomeLimits(t.TempDir()); ok {
		t.Fatal("an empty folder has no rollout")
	}
	fake := &fakeAppServer{err: Unavailable(ReasonFailed)}
	if _, err := homeUsage(now, fake).ReadGlobal(WithFetch(context.Background(), true), t.TempDir()); ReasonOf(err) != ReasonFailed {
		t.Fatalf("nothing to read: %v", err)
	}
}
