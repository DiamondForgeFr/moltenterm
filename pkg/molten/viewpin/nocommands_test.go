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

// Tab meta can be written from a terminal: a key that picks the program a terminal runs (the local shell, its
// options, its environment, its init scripts) must never reach the panel, whatever the controller says.
func TestNoCommandsDropsEveryKeyThatPicksTheProgramATerminalRuns(t *testing.T) {
	for _, key := range []string{
		waveobj.MetaKey_TermLocalShellPath,
		waveobj.MetaKey_TermLocalShellOpts,
		waveobj.MetaKey_CmdEnv,
		waveobj.MetaKey_CmdShell,
		waveobj.MetaKey_CmdInitScript,
		waveobj.MetaKey_CmdInitScriptSh,
		waveobj.MetaKey_CmdInitScriptBash,
		waveobj.MetaKey_CmdInitScriptZsh,
		waveobj.MetaKey_CmdInitScriptPwsh,
		waveobj.MetaKey_CmdInitScriptFish,
		waveobj.MetaKey_CmdRunOnStart,
		waveobj.MetaKey_CmdArgs,
		waveobj.MetaKey_Cmd,
		waveobj.MetaKey_Connection,
		"molten:resumeagent",
		"molten:agentslotagent",
		"tsunami:scope",
	} {
		for _, controller := range []string{"shell", "cmd", ""} {
			pane := waveobj.MetaMapType{waveobj.MetaKey_View: "term", key: "/tmp/evil"}
			if controller != "" {
				pane[waveobj.MetaKey_Controller] = controller
			}
			got := NoCommands(pane)
			if _, has := got[key]; has {
				t.Errorf("%q survives with controller %q: %v", key, controller, got)
			}
			if c := got.GetString(waveobj.MetaKey_Controller, ""); c != "" && c != "shell" {
				t.Errorf("controller %q for %q: %v", c, key, got)
			}
		}
	}
}

func TestNoCommandsOnlyKeepsAKnownKey(t *testing.T) {
	got := NoCommands(waveobj.MetaMapType{
		waveobj.MetaKey_View: "term",
		"term:newoption":     "x",
		"molten:newoption":   "x",
		"display:name":       "Build",
		"display:order":      2,
		"frame:title":        "Build",
		"frame:icon":         "hammer",
	})
	want := waveobj.MetaMapType{
		waveobj.MetaKey_View: "term",
		"display:name":       "Build",
		"display:order":      2,
		"frame:title":        "Build",
		"frame:icon":         "hammer",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// A panel that is not a terminal has no program to pick: its controller goes too, so another view type cannot start
// one through it.
func TestNoCommandsDropsTheControllerOfAViewThatIsNotATerminal(t *testing.T) {
	got := NoCommands(waveobj.MetaMapType{
		waveobj.MetaKey_View:       "tsunami",
		waveobj.MetaKey_Controller: "tsunami",
		"tsunami:appid":            "x",
	})
	if !reflect.DeepEqual(got, waveobj.MetaMapType{waveobj.MetaKey_View: "tsunami"}) {
		t.Fatalf("got %v", got)
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
	browser := waveobj.MetaMapType{
		waveobj.MetaKey_View:    "molten-browser",
		browserTabsMetaKey:      []any{map[string]any{"id": "a", "url": RepoToken}},
		"molten:browser:active": "a",
	}
	if got := NoCommands(browser); !reflect.DeepEqual(got, browser) {
		t.Fatalf("browser tabs %v", got)
	}
	file := waveobj.MetaMapType{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: ProjectToken + "/README.md"}
	if got := NoCommands(file); !reflect.DeepEqual(got, file) {
		t.Fatalf("file %v", got)
	}
}
