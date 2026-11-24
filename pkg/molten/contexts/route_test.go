// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package contexts

import (
	"context"
	"testing"

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
	commands := []string{CreateCommand, UpdateCommand, DeleteCommand, AssignCommand, TouchCommand, ShapesCommand, ListCommand}
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
