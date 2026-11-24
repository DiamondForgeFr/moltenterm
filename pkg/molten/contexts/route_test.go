// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package contexts

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/fileconfine"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A window and Electron main write the contexts; a terminal, an agent in it or a remote host cannot (#2476).
func TestRouteAdmitsTheWindowsAndRefusesTerminalsAndRemoteHosts(t *testing.T) {
	e := routetest.Make(t)
	applied := 0
	state := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	store := Store{
		Read: func(context.Context) (State, error) { return state, nil },
		Apply: func(_ context.Context, change Change) (State, error) {
			applied++
			next, _, err := change(state)
			return next, err
		},
	}
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: store, newId: func() string { return "new" }}).route())
	if err != nil {
		t.Fatal(err)
	}
	commands := []string{CreateCommand, UpdateCommand, DeleteCommand, AssignCommand, TouchCommand, ShapesCommand, ListCommand, FolderCommand, FolderCheckCommand}
	refused := append([]routetest.From{e.Terminal()}, e.NonLocal()...)
	for _, command := range commands {
		routetest.MustRefuse(t, link, refused, command, map[string]any{"name": "x"})
	}
	if applied != 0 {
		t.Fatalf("a refused caller changed the contexts %d times", applied)
	}
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		data, errStr := routetest.Ask(t, link, from, CreateCommand, map[string]any{"name": "DiamondForge", "emblem": "briefcase"})
		if errStr != "" {
			t.Fatalf("a create from %s: %s", from.Name, errStr)
		}
		result, ok := data.(map[string]any)
		list, _ := result["contexts"].([]any)
		if !ok || result["id"] != "new" || len(list) != 2 {
			t.Fatalf("a create from %s answered %+v", from.Name, data)
		}
	}
}

func TestRouteAnswersTheLandingOfADeletedWorkspace(t *testing.T) {
	e := routetest.Make(t)
	state := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	asked := []string{}
	store := Store{
		Read: func(context.Context) (State, error) { return state, nil },
		Apply: func(_ context.Context, change Change) (State, error) {
			next, _, err := change(state)
			return next, err
		},
		Landing: func(_ context.Context, deleted string) (string, error) {
			asked = append(asked, deleted)
			return "landing-of-" + deleted, nil
		},
	}
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: store, newId: func() string { return "new" }}).route())
	if err != nil {
		t.Fatal(err)
	}
	routetest.MustRefuse(t, link, append([]routetest.From{e.Terminal()}, e.NonLocal()...), LandingCommand, map[string]any{"workspaceid": "a"})
	if len(asked) != 0 {
		t.Fatalf("a refused caller asked for a landing: %v", asked)
	}
	data, errStr := routetest.Ask(t, link, e.Electron(), LandingCommand, map[string]any{"workspaceid": "a"})
	if errStr != "" {
		t.Fatal(errStr)
	}
	result, ok := data.(map[string]any)
	if !ok || result["id"] != "landing-of-a" {
		t.Fatalf("the landing answered %+v", data)
	}
}

// #2518: a window sets and clears a context's folder, and asks whether a workspace's folder lies outside it. The folders
// are the real ones, symbolic links followed: a link inside the context's folder that leads out counts as outside.
func TestRouteSetsAndClearsAContextFolderAndChecksAWorkspaceFolder(t *testing.T) {
	e := routetest.Make(t)
	state := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	store := Store{
		Read: func(context.Context) (State, error) { return state, nil },
		Apply: func(_ context.Context, change Change) (State, error) {
			next, _, err := change(state)
			if err == nil {
				state = next
			}
			return next, err
		},
	}
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: store, newId: func() string { return "two" }, resolve: fileconfine.ResolvePath}).route())
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	contextDir := filepath.Join(root, "clients")
	inside := filepath.Join(contextDir, "app")
	sibling := filepath.Join(root, "clients2")
	elsewhere := filepath.Join(root, "elsewhere")
	for _, dir := range []string{inside, sibling, elsewhere} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	leavingLink := filepath.Join(contextDir, "leaving")
	if err := os.Symlink(elsewhere, leavingLink); err != nil {
		t.Skipf("symbolic links are not available: %v", err)
	}
	contextLink := filepath.Join(root, "clients-link")
	if err := os.Symlink(contextDir, contextLink); err != nil {
		t.Fatal(err)
	}

	if _, errStr := routetest.Ask(t, link, e.Window(), FolderCommand, map[string]any{"id": DefaultId, "folder": contextDir + "/"}); errStr != "" {
		t.Fatalf("setting the folder: %s", errStr)
	}
	if state.Contexts[0].Folder != contextDir {
		t.Fatalf("the folder is stored cleaned: %q, want %q", state.Contexts[0].Folder, contextDir)
	}

	outside := func(folder string) bool {
		t.Helper()
		data, errStr := routetest.Ask(t, link, e.Window(), FolderCheckCommand, map[string]any{"workspaceid": "a", "folder": folder})
		if errStr != "" {
			t.Fatalf("checking %q: %s", folder, errStr)
		}
		result, ok := data.(map[string]any)
		if !ok {
			t.Fatalf("checking %q answered %+v", folder, data)
		}
		got, _ := result["outside"].(bool)
		return got
	}
	for folder, want := range map[string]bool{
		contextDir:                        false,
		inside:                            false,
		inside + "/":                      false,
		filepath.Join(inside, "new"):      false,
		sibling:                           true,
		root:                              true,
		leavingLink:                       true,
		filepath.Join(leavingLink, "x"):   true,
		contextLink:                       false,
		filepath.Join(contextLink, "app"): false,
		filepath.Join(root, "missing"):    true,
	} {
		if got := outside(folder); got != want {
			t.Errorf("outside(%q) = %v, want %v", folder, got, want)
		}
	}

	if _, errStr := routetest.Ask(t, link, e.Window(), FolderCommand, map[string]any{"id": DefaultId, "folder": ""}); errStr != "" {
		t.Fatalf("clearing the folder: %s", errStr)
	}
	if state.Contexts[0].Folder != "" {
		t.Fatalf("the folder was not cleared: %q", state.Contexts[0].Folder)
	}
	if outside(elsewhere) {
		t.Fatalf("a context without a folder bounds nothing")
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), FolderCommand, map[string]any{"id": "ghost", "folder": contextDir}); errStr == "" {
		t.Fatalf("a context that does not exist took a folder")
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), FolderCheckCommand, map[string]any{"folder": contextDir}); errStr == "" {
		t.Fatalf("a check that names no workspace and no context was answered")
	}
}

func TestRouteAnswersAWriteWithTheContextsAsWritten(t *testing.T) {
	e := routetest.Make(t)
	state := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	store := Store{
		Read: func(context.Context) (State, error) { return state, nil },
		Apply: func(_ context.Context, change Change) (State, error) {
			next, _, err := change(state)
			if err == nil {
				state = next
			}
			return next, err
		},
	}
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: store, newId: func() string { return "two" }}).route())
	if err != nil {
		t.Fatal(err)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), CreateCommand, map[string]any{"name": "Book", "workspaces": []string{"b"}}); errStr != "" {
		t.Fatal(errStr)
	}
	if state.Of["b"] != "two" {
		t.Fatalf("the create moved nothing: %v", state.Of)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), UpdateCommand, map[string]any{"id": "two", "addworkspaces": []string{"a"}}); errStr != "" {
		t.Fatal(errStr)
	}
	if state.Of["a"] != "two" || state.Of["b"] != "two" {
		t.Fatalf("an update that adds a workspace changed the others: %v", state.Of)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), UpdateCommand, map[string]any{"id": "two", "removeworkspaces": []string{"a"}}); errStr != "" {
		t.Fatal(errStr)
	}
	if state.Of["a"] != DefaultId || state.Of["b"] != "two" {
		t.Fatalf("an update that removes a workspace moved more than it: %v", state.Of)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), TouchCommand, map[string]any{"contextid": "two", "workspaceid": "b"}); errStr != "" {
		t.Fatal(errStr)
	}
	if state.Contexts[1].Last != "b" {
		t.Fatalf("the touch was not applied: %+v", state.Contexts)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), ShapesCommand, map[string]any{"shapes": map[string]string{"two": "moon", DefaultId: "v"}}); errStr != "" {
		t.Fatal(errStr)
	}
	if state.Contexts[0].Shape != "v" || state.Contexts[1].Shape != "moon" {
		t.Fatalf("the shapes were not applied: %+v", state.Contexts)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), ShapesCommand, map[string]any{"shapes": map[string]string{"two": "triangle"}}); errStr == "" {
		t.Fatalf("an unknown shape answered without an error")
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), DeleteCommand, map[string]any{"id": "ghost"}); errStr == "" {
		t.Fatalf("deleting a context that does not exist answered without an error")
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), "contextfly", nil); errStr == "" {
		t.Fatalf("an unknown command answered without an error")
	}
}
