// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestMoltenProjectSyncRouting(t *testing.T) {
	for _, line := range []string{"molten project sync", "molten project sync Notulia", "molten project sync --json"} {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil || found.Name() != "sync" {
			t.Fatalf("%q: %v, %v", line, found, err)
		}
	}
}

func TestFormatMoltenSyncEnd(t *testing.T) {
	three := 3
	zero := 0
	cases := []struct {
		run  moltenSyncRun
		want []string
	}{
		{moltenSyncRun{State: "success", Exit: &zero, Outcome: "nochange", Source: "Notulia"}, []string{"in sync, no change", "the flag on Notulia clears"}},
		{moltenSyncRun{State: "success", Exit: &zero, Outcome: "changed", Source: "Notulia", Changed: []string{"src/a.json", "src/b\x1b[2J.json"}},
			[]string{"synced, not committed: src/a.json, src/b[2J.json", "commit them on the trunk"}},
		{moltenSyncRun{State: "failure", Exit: &three, Source: "Notulia"}, []string{"the sync failure (exit 3)", "stays stale"}},
		{moltenSyncRun{State: "cancelled", Source: "Notulia"}, []string{"the sync cancelled", "stays stale"}},
	}
	for _, c := range cases {
		out := formatMoltenSyncEnd(c.run)
		for _, want := range c.want {
			if !strings.Contains(out, want) {
				t.Fatalf("missing %q in %q", want, out)
			}
		}
		if strings.Contains(out, "\x1b") {
			t.Fatalf("control characters printed: %q", out)
		}
	}
}

func TestMoltenPrintableLog(t *testing.T) {
	if got := moltenPrintableLog("a\tb\nc\x1b]52;c;eA==\x07d\r\n"); got != "a\tb\nc]52;c;eA==d\n" {
		t.Fatalf("%q", got)
	}
}

func TestFormatMoltenDepSync(t *testing.T) {
	one := 1
	acked := moltenDepState{Project: "Notulia", SourceName: "Notulia", Paths: []string{"features/*.json"}, Output: []string{"src/f.json"},
		State: moltenDepStateInSync, Acknowledged: 1700000000000, Sync: "node sync.mjs",
		LastSync: &moltenDepSyncRun{RunId: "r1", State: "success", Outcome: "nochange", StartedAt: 1700000000000}}
	out := formatMoltenDep(acked)
	if !strings.Contains(out, "Notulia: in sync, no change") || !strings.Contains(out, "last sync run: in sync, no change") {
		t.Fatalf("acknowledged:\n%s", out)
	}

	failed := moltenDepState{Project: "Notulia", SourceName: "Notulia", Paths: []string{"features/*.json"}, Output: []string{"src/f.json"},
		State: moltenDepStateStale, Sync: "node sync.mjs", LastSync: &moltenDepSyncRun{RunId: "r2", State: "failure", Exit: &one}}
	out = formatMoltenDep(failed)
	if !strings.Contains(out, "last sync run: failure (exit 1)") || !strings.Contains(out, "sync: node sync.mjs (molten project sync Notulia)") {
		t.Fatalf("failed:\n%s", out)
	}

	noSync := failed
	noSync.Sync, noSync.LastSync = "", nil
	if out = formatMoltenDep(noSync); !strings.Contains(out, "no sync command is declared") {
		t.Fatalf("no sync declared (AC6):\n%s", out)
	}
}
