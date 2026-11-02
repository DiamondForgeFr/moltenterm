// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package viewpin

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNoCommandsOpensACommandPaneAsAPlainShell(t *testing.T) {
	pane := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "cmd",
		waveobj.MetaKey_Cmd:        "rm",
		waveobj.MetaKey_CmdArgs:    []any{"-rf", "/"},
		waveobj.MetaKey_CmdShell:   false,
		waveobj.MetaKey_CmdCwd:     "/x/a",
		"cmd:runonstart":           true,
		"cmd:env":                  map[string]any{"A": "b"},
		"cmd:initscript":           "touch /tmp/x",
		waveobj.MetaKey_Connection: "user@host",
		"term:fontsize":            14,
	}
	got := NoCommands(pane)
	want := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     "/x/a",
		"term:fontsize":            14,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if pane.GetString(waveobj.MetaKey_Cmd, "") != "rm" {
		t.Fatalf("the configuration itself is not changed: %v", pane)
	}
}

func TestNoCommandsLeavesAnAgentSlotAndAPageAsTheyAre(t *testing.T) {
	slot := waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", AgentSlotMetaKey: true}
	if got := NoCommands(slot); !reflect.DeepEqual(got, slot) {
		t.Fatalf("agent slot %v", got)
	}
	page := waveobj.MetaMapType{waveobj.MetaKey_View: "molten-browser", waveobj.MetaKey_Url: RepoToken}
	if got := NoCommands(page); !reflect.DeepEqual(got, page) {
		t.Fatalf("page %v", got)
	}
}
