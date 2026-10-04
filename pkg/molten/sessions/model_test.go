// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type fakeBuild struct {
	lock      sync.Mutex
	builds    int
	sessions  []molten.DurableSession
	published []molten.DurableSessionsData
}

func (f *fakeBuild) build() (molten.DurableSessionsData, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.builds++
	out := make([]molten.DurableSession, len(f.sessions))
	copy(out, f.sessions)
	return molten.DurableSessionsData{Sessions: out}, nil
}

func (f *fakeBuild) publish(data molten.DurableSessionsData) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.published = append(f.published, data)
}

func (f *fakeBuild) set(sessions ...molten.DurableSession) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.sessions = sessions
}

func (f *fakeBuild) counts() (int, int) {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.builds, len(f.published)
}

func TestModelPublishesOnlyChanges(t *testing.T) {
	f := &fakeBuild{}
	f.set(molten.DurableSession{Id: "a", LastOutputAt: 1})
	m := MakeModel(f.build, f.publish)

	if builds, _ := f.counts(); builds != 0 {
		t.Fatalf("the first build is lazy")
	}
	first, _ := m.Snapshot()
	if first.Version != 1 {
		t.Fatalf("first version: %d", first.Version)
	}
	m.Snapshot()
	if builds, published := f.counts(); builds != 1 || published != 1 {
		t.Fatalf("a snapshot after the first reuses it: builds=%d published=%d", builds, published)
	}

	same, _ := m.Rebuild()
	if _, published := f.counts(); published != 1 || same.Version != 1 {
		t.Fatalf("nothing changed: no publish (published=%d version=%d)", published, same.Version)
	}

	f.set(molten.DurableSession{Id: "a", LastOutputAt: 2})
	next, _ := m.Rebuild()
	if _, published := f.counts(); published != 2 || next.Version != 2 {
		t.Fatalf("new output: published=%d version=%d", published, next.Version)
	}
	f.set()
	gone, _ := m.Rebuild()
	if gone.Version != 3 || len(gone.Sessions) != 0 {
		t.Fatalf("versions only grow: %+v", gone)
	}
}

func TestModelCoalescesTriggers(t *testing.T) {
	f := &fakeBuild{}
	m := MakeModel(f.build, f.publish)
	m.coalesce = 60 * time.Millisecond
	m.tick = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)
	for i := 0; i < 5; i++ {
		m.Trigger()
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	if builds, _ := f.counts(); builds != 1 {
		t.Fatalf("five triggers within the window: %d builds", builds)
	}
}

func TestModelTicks(t *testing.T) {
	f := &fakeBuild{}
	m := MakeModel(f.build, f.publish)
	m.tick = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	go m.Run(ctx)
	time.Sleep(110 * time.Millisecond)
	cancel()
	if builds, _ := f.counts(); builds < 3 {
		t.Fatalf("the tick builds: %d builds", builds)
	}
}
