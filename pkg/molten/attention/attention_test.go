// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"fmt"
	"testing"
	"time"
)

// A terminal's signal that the agent finished is a done, never a waiting warning nor an error (#409).
func TestAttentionKind(t *testing.T) {
	cases := []struct {
		signal AttentionSignal
		want   string
	}{
		{AttentionSignal{Title: "Claude Code", Message: "Task completed"}, "success"},
		{AttentionSignal{Title: "Codex: turn finished"}, "success"},
		{AttentionSignal{Title: "Claude Code", Message: "Claude needs your permission to use Bash"}, "warning"},
		{AttentionSignal{Title: BellTitle, Message: "Bell"}, "warning"},
	}
	for _, c := range cases {
		if got := attentionKind(c.signal); got != c.want {
			t.Errorf("attentionKind(%+v) = %q, want %q", c.signal, got, c.want)
		}
	}
}

func TestParseAttentionOsc(t *testing.T) {
	cases := []struct {
		payload string
		ok      bool
		want    AttentionSignal
	}{
		{"9;Claude is waiting for your input", true, AttentionSignal{Title: "Claude is waiting for your input"}},
		{"9;4;1;50", false, AttentionSignal{}},
		{"9;", false, AttentionSignal{}},
		{"777;notify;Codex;Task done; 3 files changed", true, AttentionSignal{Title: "Codex", Message: "Task done; 3 files changed"}},
		{"777;notify;;Build finished", true, AttentionSignal{Title: "Build finished"}},
		{"777;notify;;", false, AttentionSignal{}},
		{"777;other;x", false, AttentionSignal{}},
		{"7;file:///Users/me", false, AttentionSignal{}},
		{"52;c;aGVsbG8=", false, AttentionSignal{}},
	}
	for _, c := range cases {
		got, ok := ParseAttentionOsc(c.payload)
		if ok != c.ok || got != c.want {
			t.Errorf("ParseAttentionOsc(%q) = %+v, %v; want %+v, %v", c.payload, got, ok, c.want, c.ok)
		}
	}
}

func scanAll(w *attentionWatcher, block string, chunks ...string) []AttentionSignal {
	var all []AttentionSignal
	for _, chunk := range chunks {
		for _, item := range w.scan(block, []byte(chunk)) {
			if item.signal != nil && !item.repeat {
				all = append(all, *item.signal)
			}
		}
	}
	return all
}

func TestScannerFindsSignalsAcrossChunks(t *testing.T) {
	w := makeAttentionWatcher(nil)
	signals := scanAll(w, "b1",
		"output\x1b]9;Claude is wait",
		"ing for your input\x07more\x1b]777;notify;Codex;Done\x1b",
		"\\ text \x1b]7;file:///x\x07\x1b[31mred\x1b[0m",
	)
	want := []AttentionSignal{
		{Title: "Claude is waiting for your input"},
		{Title: "Codex", Message: "Done"},
	}
	if fmt.Sprint(signals) != fmt.Sprint(want) {
		t.Fatalf("signals %+v, want %+v", signals, want)
	}
}

func TestScannerBells(t *testing.T) {
	w := makeAttentionWatcher(nil)
	// A BEL that ends an OSC or a DCS string is not a bell; a lone BEL is.
	signals := scanAll(w, "b1", "\x1b]0;title\x07\x1bPtmux;x\x07plain\x07")
	if len(signals) != 1 || signals[0].Title != BellTitle {
		t.Fatalf("signals %+v, want one bell", signals)
	}
}

func TestScannerDedup(t *testing.T) {
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	w := makeAttentionWatcher(nil)
	w.now = func() time.Time { return now }
	if n := len(scanAll(w, "b1", "\x07\x07\x07")); n != 1 {
		t.Fatalf("repeated bells give %d entries, want 1", n)
	}
	if n := len(scanAll(w, "b1", "\x1b]9;Other text\x07")); n != 1 {
		t.Fatalf("a different text is recorded, got %d", n)
	}
	if n := len(scanAll(w, "b2", "\x07")); n != 1 {
		t.Fatalf("another block is recorded, got %d", n)
	}
	now = now.Add(AttentionDedup)
	if n := len(scanAll(w, "b1", "\x07")); n != 1 {
		t.Fatalf("after the window the bell is recorded again, got %d", n)
	}
}

func TestScannerBoundsLongOsc(t *testing.T) {
	w := makeAttentionWatcher(nil)
	long := make([]byte, maxOscLength*3)
	for i := range long {
		long[i] = 'x'
	}
	scanAll(w, "b1", "\x1b]9;"+string(long))
	if got := len(w.scanners["b1"].osc); got > maxOscLength {
		t.Fatalf("osc buffer grew to %d", got)
	}
}
