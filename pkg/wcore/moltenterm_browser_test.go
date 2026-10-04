// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestBlockDefInBrowser(t *testing.T) {
	src := &waveobj.BlockDef{Meta: waveobj.MetaMapType{"view": "web", "url": "https://example.com"}}
	got := blockDefInBrowser(src)
	if got.Meta.GetString("view", "") != molten.BrowserView || got.Meta.GetString("url", "") != "https://example.com" {
		t.Errorf("a web block is created as a browser panel on the same URL: got %v", got.Meta)
	}
	if src.Meta.GetString("view", "") != "web" {
		t.Errorf("the caller's block definition must not be modified")
	}
	term := &waveobj.BlockDef{Meta: waveobj.MetaMapType{"view": "term"}}
	if blockDefInBrowser(term) != term {
		t.Errorf("other blocks are left as they are")
	}
	if blockDefInBrowser(nil) != nil {
		t.Errorf("no block definition stays nil")
	}
}

func TestLegacyWebBlocksInBrowser(t *testing.T) {
	web := &waveobj.Block{OID: "w", Meta: waveobj.MetaMapType{"view": "web", "url": "https://example.com"}}
	browser := &waveobj.Block{OID: "b", Meta: waveobj.MetaMapType{"view": molten.BrowserView}}
	term := &waveobj.Block{OID: "t", Meta: waveobj.MetaMapType{"view": "term"}}
	got := legacyWebBlocksInBrowser([]*waveobj.Block{web, browser, term, nil})
	if len(got) != 1 || got[0].OID != "w" {
		t.Fatalf("only the web block migrates: got %v", got)
	}
	if got[0].Meta.GetString("view", "") != molten.BrowserView || got[0].Meta.GetString("url", "") != "https://example.com" {
		t.Errorf("the web block keeps its URL in the browser panel: got %v", got[0].Meta)
	}
	if web.Meta.GetString("view", "") != "web" {
		t.Errorf("the blocks read must not be modified")
	}
	if again := legacyWebBlocksInBrowser(got); len(again) != 0 {
		t.Errorf("a second run migrates nothing: got %v", again)
	}
}
