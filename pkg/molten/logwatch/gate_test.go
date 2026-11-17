// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"errors"
	"io/fs"
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

// FR-BOSS-012 AC1, acceptance 3: the watch starts on gold, dev and local builds only, never on a release candidate, a
// public release or a wavesrv that does not know its channel.
func TestTheWatchStartsOnInternalBuildsOnly(t *testing.T) {
	t.Parallel()
	want := map[string]bool{buildchannel.Dev: true, buildchannel.Local: true, buildchannel.Gold: true}
	for _, channel := range []string{buildchannel.Dev, buildchannel.Local, buildchannel.Gold, buildchannel.RC, buildchannel.Public,
		buildchannel.Unknown, "", "Gold", "nightly"} {
		if got := shouldStart(channel); got != want[channel] {
			t.Errorf("shouldStart(%q) = %v, want %v", channel, got, want[channel])
		}
	}
}

// Acceptance 3: on a release candidate or a public release, or with the switch off, the live gate keeps the log unread
// (no state written, no card); on a gold with the switch on, the same log raises its card.
func TestTheLiveGateKeepsTheLogUnreadOnReleases(t *testing.T) {
	serialTest(t, "it sets wavesrv's channel and switches, which buildchannel keeps for the whole process")
	cases := []struct {
		name      string
		channel   string
		narrowing buildchannel.Narrowing
		reads     bool
	}{
		{"release candidate", buildchannel.RC, buildchannel.Narrowing{}, false},
		{"public release", buildchannel.Public, buildchannel.Narrowing{}, false},
		{"unknown channel", buildchannel.Unknown, buildchannel.Narrowing{}, false},
		{"gold, switched off", buildchannel.Gold, buildchannel.Narrowing{Off: []string{buildchannel.FeatureLogWatch}}, false},
		{"gold, public version", buildchannel.Gold, buildchannel.Narrowing{Public: true}, false},
		{"gold", buildchannel.Gold, buildchannel.Narrowing{}, true},
		{"dev", buildchannel.Dev, buildchannel.Narrowing{}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			restore := buildchannel.StartAsForTest(c.channel, c.narrowing)
			defer restore()
			w, fe, path := makeTestWatcher(t)
			w.env.Enabled = buildchannel.LogWatchEnabled
			appendLog(t, path, panicLines(day.Add(-time.Minute), "nil map", "step"))
			look(t, w)
			_, err := os.Stat(statePath(w.env.DataDir))
			read := err == nil
			if read != c.reads || (!read && !errors.Is(err, fs.ErrNotExist)) {
				t.Fatalf("state written: %v (%v), want %v", read, err, c.reads)
			}
			if got := len(fe.published()) > 0; got != c.reads {
				t.Fatalf("cards %v, want some: %v", cardKeys(fe.published()), c.reads)
			}
		})
	}
}
