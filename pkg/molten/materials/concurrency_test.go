// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"os"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestSweepPreservesActiveCapture(t *testing.T) {
	h := makeHarness(t)
	path := h.write("page.txt", "A material")
	copied := make(chan struct{})
	resume := make(chan struct{})
	h.r.store.killPoint = func(point string) {
		if point == "copy:file" {
			close(copied)
			<-resume
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := h.r.Add("block-1", "", path, "", "", false, molten.MaterialSourceDeclared)
		done <- err
	}()
	<-copied
	h.r.store.Sweep(h.r.limits.TrashKeep)
	close(resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	list := h.list()
	if len(list) != 1 || list[0].Copy != molten.MaterialCopyKept {
		t.Fatalf("capture was not kept: %+v", list)
	}
	if _, err := os.Stat(list[0].CopyPath); err != nil {
		t.Fatal(err)
	}
}

func TestContextConcurrentRefresh(t *testing.T) {
	h := makeHarness(t)
	h.r.context("block-1")
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			h.r.lock.Lock()
			h.r.blocks["block-1"].readAt = time.Time{}
			h.r.lock.Unlock()
			h.r.context("block-1")
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			bc := h.r.context("block-1")
			h.r.contextIdentity(bc)
		}
	}()
	wg.Wait()
}
