// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The companion's sentences carry their codes for the windows (#656); the English stays what it was.
func TestCompanionTextsAreCoded(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b1": {BlockId: "b1", Agent: "claude", Running: true}},
		cwds:  map[string]string{"b1": cwd, "b2": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	t.Cleanup(func() {
		m.Close("b1", "v")
		m.Close("b2", "v")
	})

	if _, err := m.Answer("nope", 0); uimsg.TextOf(err).Code != "companion.notopen" || err.Error() != "the companion of this terminal is not open" {
		t.Fatalf("answer of a closed companion: %v", err)
	}
	if _, err := m.Open("b2", "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Pick("b2", "v", filepath.Join(root, "x.jsonl")); uimsg.TextOf(err).Code != "companion.noagentruns" {
		t.Fatalf("pick without an agent: %v", err)
	}
	if _, err := m.Open("b1", "v"); err != nil {
		t.Fatal(err)
	}
	waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusSearching })
	_, err := m.Pick("b1", "v", "relative.jsonl")
	if text := uimsg.TextOf(err); text == nil || text.Code != "companion.transcriptinvalid" || text.Vars["detail"] == "" {
		t.Fatalf("pick of an invalid path: %v %+v", err, text)
	}

	// A watcher of its own, without its loop: the status set here stays.
	w := makeWatcher(m, "bx")
	w.setStatus(StatusSearching, uimsg.Make("companion.foldernotknown"), "This terminal's folder is not known yet.")
	v := w.view(false)
	if v.Message != "This terminal's folder is not known yet." || v.MessageText == nil || v.MessageText.Code != "companion.foldernotknown" {
		t.Fatalf("view: %q %+v", v.Message, v.MessageText)
	}
}
