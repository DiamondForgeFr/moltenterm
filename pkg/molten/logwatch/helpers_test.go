// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
)

// Every log here is synthetic: written by the test in its own folder, never the developer's.

// day is the synthetic logs' day, in UTC (the tests read the stamps in UTC).
var day = time.Date(2026, 3, 9, 10, 0, 0, 0, time.UTC)

const fakeHome = "/home/devname"

func stamped(at time.Time, text string) string {
	var sb strings.Builder
	for i, line := range strings.Split(text, "\n") {
		if i == 0 {
			sb.WriteString(at.Format(timestampLayout) + " " + line + "\n")
			continue
		}
		sb.WriteString(line + "\n")
	}
	return sb.String()
}

// panicLines is a recovered panic as Electron main writes wavesrv's output: one stamped entry per line.
func panicLines(at time.Time, message string, function string) string {
	lines := []string{
		"[wavesrv] [panic] in molten:fake:loop: " + message,
		"goroutine 4242 [running]:",
		"runtime/debug.Stack()",
		"\t/usr/local/go/src/runtime/debug/stack.go:26 +0x5e",
		"runtime/debug.PrintStack()",
		"\t/usr/local/go/src/runtime/debug/stack.go:18 +0x13",
		"github.com/wavetermdev/waveterm/pkg/panichandler.PanicHandler({0x1, 0x2}, {0x3, 0x4})",
		"\t" + fakeHome + "/src/pkg/panichandler/panichandler.go:30 +0x7a",
		"panic({0x5, 0x6})",
		"\t/usr/local/go/src/runtime/panic.go:791 +0x132",
		"github.com/wavetermdev/waveterm/pkg/molten/fake.(*worker)." + function + "(0xc000123456, 0x3)",
		"\t" + fakeHome + "/src/pkg/molten/fake/worker.go:42 +0x1d",
		"github.com/wavetermdev/waveterm/pkg/molten/fake.(*worker).loop(0xc000123456)",
		"\t" + fakeHome + "/src/pkg/molten/fake/worker.go:30 +0x55",
		"created by github.com/wavetermdev/waveterm/pkg/molten/fake.Start in goroutine 1",
		"\t" + fakeHome + "/src/pkg/molten/fake/worker.go:12 +0x22",
	}
	var sb strings.Builder
	for _, line := range lines {
		sb.WriteString(stamped(at, line))
	}
	return sb.String()
}

func appendLog(t *testing.T, path string, text string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// fakeEnv is a watcher's world: a data folder of the test, a clock it moves, what is published and sent.
type fakeEnv struct {
	lock    sync.Mutex
	now     time.Time
	enabled bool
	cards   []molten.NotificationInput
	sent    []agenthandoff.AppRequest
	agents  []Agent
	locks   []molten.AgentNameLock
	ours    map[string]bool
	sendErr error
}

func (e *fakeEnv) clock() time.Time {
	e.lock.Lock()
	defer e.lock.Unlock()
	return e.now
}

func (e *fakeEnv) advance(d time.Duration) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.now = e.now.Add(d)
}

func (e *fakeEnv) setEnabled(on bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.enabled = on
}

func (e *fakeEnv) isEnabled() bool {
	e.lock.Lock()
	defer e.lock.Unlock()
	return e.enabled
}

func (e *fakeEnv) published() []molten.NotificationInput {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]molten.NotificationInput(nil), e.cards...)
}

func (e *fakeEnv) takeCards() []molten.NotificationInput {
	e.lock.Lock()
	defer e.lock.Unlock()
	cards := e.cards
	e.cards = nil
	return cards
}

func (e *fakeEnv) requests() []agenthandoff.AppRequest {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]agenthandoff.AppRequest(nil), e.sent...)
}

func makeTestWatcher(t *testing.T) (*Watcher, *fakeEnv, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, LogsDirName), 0o700); err != nil {
		t.Fatal(err)
	}
	fe := &fakeEnv{now: day, enabled: true, ours: map[string]bool{}}
	env := Env{
		DataDir:  dir,
		Home:     fakeHome,
		Location: time.UTC,
		Now:      fe.clock,
		Enabled:  fe.isEnabled,
		Publish: func(ctx context.Context, input molten.NotificationInput) error {
			fe.lock.Lock()
			defer fe.lock.Unlock()
			fe.cards = append(fe.cards, input)
			return nil
		},
		Agents: func(ctx context.Context) []Agent {
			fe.lock.Lock()
			defer fe.lock.Unlock()
			return append([]Agent(nil), fe.agents...)
		},
		Locks: func() []molten.AgentNameLock {
			fe.lock.Lock()
			defer fe.lock.Unlock()
			return append([]molten.AgentNameLock(nil), fe.locks...)
		},
		IsMoltenTerm: func(ctx context.Context, dir string) bool {
			fe.lock.Lock()
			defer fe.lock.Unlock()
			return fe.ours[dir]
		},
		Send: func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error) {
			fe.lock.Lock()
			defer fe.lock.Unlock()
			if fe.sendErr != nil {
				return agenthandoff.AppSent{}, fe.sendErr
			}
			fe.sent = append(fe.sent, req)
			for _, a := range fe.agents {
				if a.BlockId == req.ToBlockId {
					return agenthandoff.AppSent{Status: agenthandoff.StatusDelivered, To: a.FirstName}, nil
				}
			}
			return agenthandoff.AppSent{Status: agenthandoff.StatusDelivered}, nil
		},
		Channel: "gold",
		Version: "1.0.0-test",
	}
	w := MakeWatcher(env)
	return w, fe, filepath.Join(dir, LogFileName)
}

func look(t *testing.T, w *Watcher) {
	t.Helper()
	if err := w.Look(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func cardKeys(cards []molten.NotificationInput) []string {
	var out []string
	for _, c := range cards {
		mode := "raise"
		if c.RefreshOnly {
			mode = "refresh"
		}
		out = append(out, fmt.Sprintf("%s/%s", mode, c.Title))
	}
	return out
}

func raised(cards []molten.NotificationInput) []molten.NotificationInput {
	var out []molten.NotificationInput
	for _, c := range cards {
		if !c.RefreshOnly {
			out = append(out, c)
		}
	}
	return out
}
