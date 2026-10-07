// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestDetectSharesProbesAndExpiresSuccess(t *testing.T) {
	skipOnWindows(t)
	bin := filepath.Join(t.TempDir(), "bin")
	writeFakeAgent(t, bin, "codex", `exit 0`)
	var lock sync.Mutex
	calls := 0
	release := make(chan struct{})
	probe := func(ctx context.Context, path string, env []string) (string, error) {
		lock.Lock()
		calls++
		lock.Unlock()
		<-release
		return "codex-cli 0.160.1", nil
	}
	d := MakeDetector(probe, 5*time.Second)
	now := time.Now()
	d.now = func() time.Time { return now }
	env := DetectEnv{PathList: bin}
	var wg sync.WaitGroup
	results := make([]Detection, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = d.Detect(context.Background(), "codex", env)
		}(i)
	}
	time.Sleep(200 * time.Millisecond)
	close(release)
	wg.Wait()
	for _, r := range results {
		if !r.Installed || r.Version != "0.160.1" {
			t.Errorf("shared probe result %+v", r)
		}
	}
	if calls != 1 {
		t.Errorf("%d probes for concurrent callers", calls)
	}
	d.Detect(context.Background(), "codex", env)
	now = now.Add(successProbeCacheTTL)
	d.Detect(context.Background(), "codex", env)
	if calls != 2 {
		t.Errorf("a success is probed again after its TTL: %d probes", calls)
	}
}

func TestDetectCancelledReason(t *testing.T) {
	skipOnWindows(t)
	bin := filepath.Join(t.TempDir(), "bin")
	writeFakeAgent(t, bin, "codex", `exit 0`)
	d := MakeDetector(func(ctx context.Context, path string, env []string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}, 5*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if got := d.Detect(ctx, "codex", DetectEnv{PathList: bin}); got.Installed || got.Reason != ReasonCancelled {
		t.Errorf("parent deadline %+v", got)
	}
	if len(d.cache) != 0 || len(d.inflight) != 0 {
		t.Error("a cancelled probe was kept")
	}
}

func TestPlannedAgentsAreNeverRun(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	marker := filepath.Join(dir, "ran")
	writeFakeAgent(t, bin, "gemini", `touch "`+marker+`"; echo 0.63.0`)
	listings := Default().List(context.Background(), MakeDetector(RunVersionProbe, AnsweringProbeTimeout), DetectEnv{PathList: bin}, ModelEnv{Home: dir})
	found := false
	for _, l := range listings {
		if l.Id != molten.AgentIdGemini {
			continue
		}
		found = true
		if !l.Installed || l.Path != filepath.Join(bin, "gemini") || l.Version != "" || l.Offered() {
			t.Errorf("planned gemini %+v", l)
		}
	}
	if !found {
		t.Error("gemini is not listed")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a planned agent was run")
	}
}

func TestCleanText(t *testing.T) {
	if got := CleanLabel("  GPT\x1b[31m-6\x07 "); got != "GPT[31m-6" {
		t.Errorf("CleanLabel %q", got)
	}
	if got := CleanLabel(strings.Repeat("é", 100)); got != strings.Repeat("é", maxLabelRunes)+"…" {
		t.Errorf("long label %q", got)
	}
	if got := StripControl("/tmp/a\x1b]0;x\x07/b\n"); got != "/tmp/a]0;x/b" {
		t.Errorf("StripControl %q", got)
	}
}
