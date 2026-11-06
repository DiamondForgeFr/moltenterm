// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package filestore

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestDirtyCacheSnapshotWaitsForEntryAndBalancesPins(t *testing.T) {
	key := cacheKey{ZoneId: "synthetic-zone", Name: "var"}
	entry := makeCacheEntry(key.ZoneId, key.Name)
	entry.PinCount = 1
	s := &FileStore{Lock: &sync.Mutex{}, Cache: map[cacheKey]*CacheEntry{key: entry}}
	entry.Lock.Lock()
	locked := true
	finished := make(chan struct{})
	t.Cleanup(func() {
		if locked {
			entry.Lock.Unlock()
		}
		select {
		case <-finished:
		case <-time.After(30 * time.Second):
			t.Error("dirty scan worker did not stop")
		}
	})
	done := make(chan []cacheKey, 1)
	go func() {
		defer close(finished)
		done <- s.getDirtyCacheKeys()
	}()
	deadline := time.Now().Add(30 * time.Second)
	for {
		select {
		case <-done:
			t.Fatal("dirty scan read an entry before its loading writer released the lock")
		default:
		}
		s.Lock.Lock()
		pins := entry.PinCount
		s.Lock.Unlock()
		if pins == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("dirty scan did not pin its snapshot")
		}
		runtime.Gosched()
	}
	entry.File = &WaveFile{}
	entry.Lock.Unlock()
	locked = false
	select {
	case keys := <-done:
		if len(keys) != 1 || keys[0] != key {
			t.Fatalf("dirty keys: %+v", keys)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("dirty scan did not finish after the entry was loaded")
	}
	if entry.PinCount != 1 {
		t.Fatalf("snapshot leaked a pin: %d", entry.PinCount)
	}
	s.unpinEntryAndTryDelete(key.ZoneId, key.Name)
	if entry.PinCount != 0 || s.Cache[key] != entry {
		t.Fatal("dirty entry lost or pin unbalanced")
	}
	entry.Lock.Lock()
	entry.File = nil
	entry.Lock.Unlock()
	if keys := s.getDirtyCacheKeys(); len(keys) != 0 {
		t.Fatalf("clean entry included: %+v", keys)
	}
	if len(s.Cache) != 0 {
		t.Fatal("clean unpinned entry was retained")
	}
}

func TestDirtyCacheSnapshotConcurrentLoading(t *testing.T) {
	s := &FileStore{Lock: &sync.Mutex{}, Cache: make(map[cacheKey]*CacheEntry)}
	var workers sync.WaitGroup
	workers.Add(2)
	start := make(chan struct{})
	go func() {
		defer workers.Done()
		<-start
		for i := 0; i < 500; i++ {
			_ = withLock(s, "synthetic-zone", "var", func(entry *CacheEntry) error {
				entry.File = &WaveFile{}
				return nil
			})
		}
	}()
	go func() {
		defer workers.Done()
		<-start
		for i := 0; i < 500; i++ {
			s.getDirtyCacheKeys()
		}
	}()
	close(start)
	workers.Wait()
	s.Lock.Lock()
	defer s.Lock.Unlock()
	for _, entry := range s.Cache {
		if entry.PinCount != 0 {
			t.Fatalf("snapshot leaked pins: %d", entry.PinCount)
		}
	}
}
