// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestBuildNotice(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	start := now.Add(-10 * time.Minute).UnixMilli()
	rec := RunRecord{Kind: RunKindBuild, Title: "Gold", State: RunStateSuccess, StartedAt: start, FinishedAt: now.UnixMilli(),
		Commit: "9c425c4abcdef0123456789", Artifact: "/builds/gold/Notulia.app"}
	manifest := &BuildManifest{ProductName: "Notulia Gold", Commit: rec.Commit, BuiltAt: "2026-10-03T11:58:00Z", Notes: make([]any, 12)}
	input, ok := buildNotice(rec, manifest, "Notulia", now)
	if !ok || input.Title != "Notulia Gold is ready" || input.Kind != "info" ||
		input.Message != "Build 9c425c4 delivered to the local builds folder (12 commit(s) since the previous one)." {
		t.Fatalf("delivered: %+v", input)
	}
	if len(input.Actions) != 2 || input.Actions[0].Gesture != "path:reveal" || !input.Actions[0].Lasting || input.Actions[1].View != "molten-project" {
		t.Fatalf("delivered actions: %+v", input.Actions)
	}
	if built, _ := buildNotice(rec, nil, "Notulia", now); built.Title != "Notulia Gold is built" {
		t.Fatalf("a success without this run's manifest still says it: %+v", built)
	}
	failed := rec
	failed.State = RunStateLost
	if stopped, ok := buildNotice(failed, nil, "Notulia", now); !ok || stopped.Kind != "error" || stopped.Title != "The Notulia Gold build stopped" || len(stopped.Actions) != 1 {
		t.Fatalf("stopped: %+v", stopped)
	}
	cancelled := rec
	cancelled.State = RunStateCancelled
	if _, ok := buildNotice(cancelled, nil, "Notulia", now); ok {
		t.Fatal("a build the user cancelled is not told")
	}
	if _, ok := buildNotice(rec, manifest, "Notulia", now.Add(7*time.Hour)); ok {
		t.Fatal("an outcome older than 6 hours is not news")
	}
	told := rec
	told.Told = true
	if _, ok := buildNotice(told, manifest, "Notulia", now); ok {
		t.Fatal("an outcome is told once")
	}
}

func TestBuildEndIsToldOnce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo built"},{"id":"bad","title":"Bad","run":"exit 4"}`)
	var lock sync.Mutex
	var told []molten.NotificationInput
	r.UseNotifier(func(rec RunRecord, input molten.NotificationInput) {
		lock.Lock()
		defer lock.Unlock()
		told = append(told, input)
	})
	ok := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	bad := waitRun(t, r, dir, trustAndStart(t, r, dir, "bad").Id)
	for i := 0; i < 5; i++ {
		r.List(dir)
	}
	time.Sleep(200 * time.Millisecond)
	lock.Lock()
	defer lock.Unlock()
	if len(told) != 2 || !strings.HasSuffix(told[0].Title, "is built") || told[1].Title != "The fixture Bad build stopped" {
		t.Fatalf("each end told once: %+v", told)
	}
	for _, rec := range []RunRecord{ok, bad} {
		data, _ := os.ReadFile(filepath.Join(r.projectDir(dir), rec.Id, RunFileName))
		if !strings.Contains(string(data), `"told": true`) {
			t.Fatalf("the record keeps told: %s", data)
		}
	}
}
