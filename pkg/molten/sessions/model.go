// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"log"
	"reflect"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
	// Events close together (a tab closing sends several) make one build.
	triggerCoalesce = 300 * time.Millisecond
	// What raises no event: a session no pane shows exiting, its last output, its processes.
	tickPeriod = 5 * time.Second
)

// Model keeps the last list. A build reads everything again (one database read, one read of the process table);
// the list is published only when it changed, with a version that only grows, so a window that took a snapshot
// while an event travelled keeps the newer one.
type Model struct {
	// buildLock serializes builds, so two publishes never go out of order.
	buildLock sync.Mutex
	lock      sync.Mutex
	data      molten.DurableSessionsData
	built     bool

	build    func() (molten.DurableSessionsData, error)
	publish  func(molten.DurableSessionsData)
	trigger  chan struct{}
	coalesce time.Duration
	tick     time.Duration
}

func MakeModel(build func() (molten.DurableSessionsData, error), publish func(molten.DurableSessionsData)) *Model {
	return &Model{
		build:    build,
		publish:  publish,
		trigger:  make(chan struct{}, 1),
		coalesce: triggerCoalesce,
		tick:     tickPeriod,
	}
}

func (m *Model) current() (molten.DurableSessionsData, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.data, m.built
}

// store keeps the new list and reports whether it differs from the last one (the version aside).
func (m *Model) store(next molten.DurableSessionsData) (molten.DurableSessionsData, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.built && m.data.RunningAgents == next.RunningAgents && reflect.DeepEqual(m.data.Sessions, next.Sessions) {
		return m.data, false
	}
	next.Version = m.data.Version + 1
	m.data = next
	m.built = true
	return next, true
}

// Rebuild builds the list now and publishes it when it changed.
func (m *Model) Rebuild() (molten.DurableSessionsData, error) {
	m.buildLock.Lock()
	defer m.buildLock.Unlock()
	next, err := m.build()
	if err != nil {
		data, _ := m.current()
		return data, err
	}
	data, changed := m.store(next)
	if changed && m.publish != nil {
		m.publish(data)
	}
	return data, nil
}

// Snapshot is the last list; the first call builds it.
func (m *Model) Snapshot() (molten.DurableSessionsData, error) {
	if data, built := m.current(); built {
		return data, nil
	}
	return m.Rebuild()
}

// Trigger asks for a build soon; triggers within the coalescing window make one.
func (m *Model) Trigger() {
	select {
	case m.trigger <- struct{}{}:
	default:
	}
}

func (m *Model) rebuildLogged() {
	if _, err := m.Rebuild(); err != nil {
		log.Printf("molten: sessions not built: %v\n", err)
	}
}

// Run builds on triggers and on the tick until ctx ends.
func (m *Model) Run(ctx context.Context) {
	defer func() {
		panichandler.PanicHandler("molten:sessions:run", recover())
	}()
	ticker := time.NewTicker(m.tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.rebuildLogged()
		case <-m.trigger:
			select {
			case <-ctx.Done():
				return
			case <-time.After(m.coalesce):
			}
			// Triggers that came during the wait are covered by this build.
			select {
			case <-m.trigger:
			default:
			}
			m.rebuildLogged()
		}
	}
}
