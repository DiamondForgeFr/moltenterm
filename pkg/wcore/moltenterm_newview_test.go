// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNewViewLayout(t *testing.T) {
	plain := newViewLayout(nil)
	if len(plain) != 1 || plain[0].BlockDef.Meta[waveobj.MetaKey_View] != "term" {
		t.Fatalf("no block def must give the usual terminal, got %+v", plain)
	}
	empty := newViewLayout(&waveobj.BlockDef{})
	if empty[0].BlockDef.Meta[waveobj.MetaKey_View] != "term" {
		t.Fatalf("an empty block def must give the usual terminal, got %+v", empty)
	}
	def := &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "launcher", "molten:newview": true}}
	chooser := newViewLayout(def)
	if len(chooser) != 1 || chooser[0].BlockDef != def || !chooser[0].Focused {
		t.Fatalf("the block def must be the tab's only, focused block, got %+v", chooser)
	}
}
