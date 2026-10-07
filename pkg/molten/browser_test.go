// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestBrowserBlockMeta(t *testing.T) {
	src := waveobj.MetaMapType{"view": "web", "url": "https://example.com", "web:zoom": 1.5}
	got, changed := BrowserBlockMeta(src)
	if !changed {
		t.Fatalf("a web block must move to the browser panel")
	}
	if got["view"] != BrowserView || got["url"] != "https://example.com" || got["web:zoom"] != 1.5 {
		t.Errorf("view switched, every other key kept: got %v", got)
	}
	if src["view"] != "web" {
		t.Errorf("the source meta must not be modified")
	}
	again, changed := BrowserBlockMeta(got)
	if changed || again["view"] != BrowserView {
		t.Errorf("a browser block is left as is, so the migration is idempotent")
	}
	for _, meta := range []waveobj.MetaMapType{nil, {"view": "term"}, {"view": "help"}, {"url": "https://example.com"}} {
		if _, changed := BrowserBlockMeta(meta); changed {
			t.Errorf("%v is not a web block", meta)
		}
	}
}

func TestBrowserPageURL(t *testing.T) {
	tabs := []any{
		map[string]any{"id": "a", "url": "https://a.example"},
		map[string]any{"id": "b", "url": "https://b.example", "title": "B"},
	}
	cases := []struct {
		name string
		meta waveobj.MetaMapType
		want string
	}{
		{"active tab", waveobj.MetaMapType{"url": "https://old", BrowserTabsMetaKey: tabs, BrowserActiveMetaKey: "b"}, "https://b.example"},
		{"unknown active tab falls back to the first", waveobj.MetaMapType{BrowserTabsMetaKey: tabs, BrowserActiveMetaKey: "x"}, "https://a.example"},
		{"no saved tabs yet", waveobj.MetaMapType{"url": "https://example.com"}, "https://example.com"},
		{"malformed tabs", waveobj.MetaMapType{"url": "https://example.com", BrowserTabsMetaKey: []any{"x", map[string]any{"id": 3}}}, "https://example.com"},
		{"nothing", waveobj.MetaMapType{}, ""},
	}
	for _, tc := range cases {
		if got := BrowserPageURL(tc.meta); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestPickBrowserPanel(t *testing.T) {
	cases := []struct {
		name   string
		panels []string
		recent any
		want   string
	}{
		{"no panel: a new one", nil, []any{"b1"}, ""},
		{"most recently focused", []string{"b1", "b2", "b3"}, []any{"b2", "b3"}, "b2"},
		{"a closed panel is skipped", []string{"b1", "b3"}, []any{"gone", "b3", "b1"}, "b3"},
		{"never focused: the last panel", []string{"b1", "b2"}, nil, "b2"},
		{"malformed history", []string{"b1", "b2"}, "b1", "b2"},
		{"non-string ids ignored", []string{"b1", "b2"}, []any{3, "b1"}, "b1"},
	}
	for _, tc := range cases {
		if got := PickBrowserPanel(tc.panels, tc.recent); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// FR-BRW-007: a page from BROWSER is queued like any other, with the ask and keep-focus flags the panel reads.
func TestBrowserEnvRequestMeta(t *testing.T) {
	meta := waveobj.MergeMeta(waveobj.MetaMapType{"view": BrowserView}, BrowserEnvRequestMeta("0001", "https://example.com", true), false)
	meta = waveobj.MergeMeta(meta, BrowserEnvRequestMeta("0002", "https://example.org", false), false)
	entry, ok := meta[BrowserOpenKeyPrefix+"0001"].(map[string]any)
	if !ok || entry["url"] != "https://example.com" || entry["ask"] != true || entry["keepfocus"] != true {
		t.Fatalf("got %v", meta)
	}
	entry, ok = meta[BrowserOpenKeyPrefix+"0002"].(map[string]any)
	if _, asks := entry["ask"]; !ok || asks || entry["keepfocus"] != true {
		t.Fatalf("a page sent back by a browser never asks: got %v", entry)
	}
	block := BrowserEnvBlockMeta("https://example.com", true)
	if block["view"] != BrowserView || block["url"] != "https://example.com" || block[BrowserAskMetaKey] != true || block[BrowserKeepFocusMetaKey] != true {
		t.Fatalf("new panel meta: got %v", block)
	}
	if _, asks := BrowserEnvBlockMeta("https://example.com", false)[BrowserAskMetaKey]; asks {
		t.Fatalf("a new panel without ask must not carry the ask flag")
	}
}

// Two wsh opens land before the panel reacts: setmeta merges each into the block meta (as UpdateObjectMeta does), so
// neither drops the other; the panel's removal of what it opened keeps a page queued meanwhile.
func TestBrowserOpenQueue(t *testing.T) {
	meta := waveobj.MetaMapType{"view": BrowserView}
	meta = waveobj.MergeMeta(meta, BrowserOpenRequestMeta("0001", "https://example.com/a"), false)
	meta = waveobj.MergeMeta(meta, BrowserOpenRequestMeta("0002", "https://example.com/b"), false)
	if meta[BrowserOpenKeyPrefix+"0001"] != "https://example.com/a" || meta[BrowserOpenKeyPrefix+"0002"] != "https://example.com/b" {
		t.Fatalf("both requests queued: got %v", meta)
	}
	meta = waveobj.MergeMeta(meta, BrowserOpenRequestMeta("0003", "https://example.com/c"), false)
	meta = waveobj.MergeMeta(meta, waveobj.MetaMapType{BrowserOpenKeyPrefix + "0001": nil, BrowserOpenKeyPrefix + "0002": nil}, false)
	_, has1 := meta[BrowserOpenKeyPrefix+"0001"]
	_, has2 := meta[BrowserOpenKeyPrefix+"0002"]
	if has1 || has2 || meta[BrowserOpenKeyPrefix+"0003"] != "https://example.com/c" || meta["view"] != BrowserView {
		t.Errorf("only the opened pages leave the queue: got %v", meta)
	}
}
