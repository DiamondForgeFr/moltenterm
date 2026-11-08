// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestAgentNotesWithoutDropsTheTerminalAndItsSubAgents(t *testing.T) {
	raw := map[string]any{
		"blk-a":         "audit sécu nov6, ne pas relancer",
		"blk-a/sub-1":   "à relire",
		"blk-a/sub-2":   "attend le gold",
		"blk-b":         "revoir demain",
		"blk-b/sub-1":   "garde",
		"blk-ab":        "a prefix is not a parent",
		"blk-a-sibling": "nor is a longer id",
	}
	kept, dropped := agentNotesWithout(raw, "blk-a")
	if !dropped {
		t.Fatalf("the notes of blk-a were not found")
	}
	want := map[string]any{
		"blk-b":         "revoir demain",
		"blk-b/sub-1":   "garde",
		"blk-ab":        "a prefix is not a parent",
		"blk-a-sibling": "nor is a longer id",
	}
	if !reflect.DeepEqual(kept, want) {
		t.Fatalf("kept %v, want %v", kept, want)
	}
	if _, dropped := agentNotesWithout(raw, "blk-z"); dropped {
		t.Fatalf("nothing to drop for blk-z")
	}
}

func TestAgentNotesWithoutLeavesOtherShapesAlone(t *testing.T) {
	for _, raw := range []any{nil, "text", []any{"a"}, 3.0} {
		if _, dropped := agentNotesWithout(raw, "blk-a"); dropped {
			t.Fatalf("%v is not a notes map", raw)
		}
	}
	if _, dropped := agentNotesWithout(map[string]any{"blk-a": "x"}, ""); dropped {
		t.Fatalf("no block id drops nothing")
	}
}

func initNotesStore(t *testing.T) {
	t.Helper()
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })
	if err := os.MkdirAll(filepath.Join(dataDir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatal(err)
	}
}

func insertWorkspace(t *testing.T, oid string, meta waveobj.MetaMapType) {
	t.Helper()
	if err := wstore.DBInsert(context.Background(), &waveobj.Workspace{OID: oid, Name: oid, Meta: meta}); err != nil {
		t.Fatalf("inserting %s: %v", oid, err)
	}
}

func workspaceMeta(t *testing.T, oid string) waveobj.MetaMapType {
	t.Helper()
	ws, err := wstore.DBMustGet[*waveobj.Workspace](context.Background(), oid)
	if err != nil {
		t.Fatalf("reading %s: %v", oid, err)
	}
	return ws.Meta
}

func TestDropAgentNotesWhenTheTerminalCloses(t *testing.T) {
	initNotesStore(t)
	insertWorkspace(t, "ws-notes", waveobj.MetaMapType{
		molten.AgentNotesMetaKey: map[string]any{"blk-a": "audit", "blk-a/sub-1": "relire", "blk-b": "demain"},
		"other":                  "kept",
	})
	insertWorkspace(t, "ws-only-a", waveobj.MetaMapType{
		molten.AgentNotesMetaKey: map[string]any{"blk-a": "seul"},
	})
	insertWorkspace(t, "ws-none", waveobj.MetaMapType{"other": "kept"})

	handleAgentBlockClose(&wps.WaveEvent{Event: wps.Event_BlockClose, Data: "blk-a"})

	notes, _ := workspaceMeta(t, "ws-notes")[molten.AgentNotesMetaKey].(map[string]any)
	if !reflect.DeepEqual(notes, map[string]any{"blk-b": "demain"}) {
		t.Fatalf("the other terminal's note must stay, got %v", notes)
	}
	if workspaceMeta(t, "ws-notes")["other"] != "kept" {
		t.Fatalf("the rest of the workspace's meta must stay")
	}
	if _, has := workspaceMeta(t, "ws-only-a")[molten.AgentNotesMetaKey]; has {
		t.Fatalf("a workspace left with no note must not keep an empty map")
	}
	if workspaceMeta(t, "ws-none")["other"] != "kept" {
		t.Fatalf("a workspace with no notes is left alone")
	}
}
