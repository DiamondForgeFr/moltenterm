// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package learning

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func routeEnv(t *testing.T) (*routetest.Env, *localroute.Link, *Store) {
	t.Helper()
	e := routetest.Make(t)
	s, _ := clockedStore(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{s: s}).route())
	if err != nil {
		t.Fatal(err)
	}
	return e, link, s
}

func record(workflow string, key string, value string) molten.LearningRequest {
	return molten.LearningRequest{Workflow: workflow, Kind: molten.LearningKindPreference, Key: key, Value: value}
}

// A remote host reaches nothing; a terminal cannot edit a value or reset a workflow.
func TestRouteCallers(t *testing.T) {
	e, link, s := routeEnv(t)
	wf := molten.LearningWorkflowPipelineSetup
	local := []string{molten.LearningListCommand, molten.LearningDefaultsCommand, molten.LearningRecordCommand, molten.LearningForgetCommand}
	for _, command := range append(local, molten.LearningEditCommand, molten.LearningResetCommand) {
		routetest.MustRefuse(t, link, e.NonLocal(), command, record(wf, "merge", "squash"))
	}
	for _, command := range []string{molten.LearningEditCommand, molten.LearningResetCommand} {
		routetest.MustRefuseWith(t, link, []routetest.From{e.Terminal()}, command, molten.LearningRequest{Workflow: wf, Id: "preference:merge", Value: "x"}, "MoltenTerm windows only")
	}
	if items, _ := s.List(wf); len(items) != 0 {
		t.Fatalf("a refused caller changed the store: %+v", items)
	}
	for _, from := range []routetest.From{e.Window(), e.Electron(), e.Terminal()} {
		if _, errStr := routetest.Ask(t, link, from, molten.LearningListCommand, nil); errStr != "" {
			t.Errorf("the list for %s: %s", from.Name, errStr)
		}
		if _, errStr := routetest.Ask(t, link, from, molten.LearningDefaultsCommand, molten.LearningRequest{Workflow: wf}); errStr != "" {
			t.Errorf("the defaults for %s: %s", from.Name, errStr)
		}
	}
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		if _, errStr := routetest.Ask(t, link, from, molten.LearningResetCommand, molten.LearningRequest{Workflow: wf}); errStr != "" {
			t.Errorf("reset for %s: %s", from.Name, errStr)
		}
	}
}

// Who recorded an item comes from the router's proof of the caller, never from the request.
func TestRouteStampsWhoRecorded(t *testing.T) {
	e, link, _ := routeEnv(t)
	wf := molten.LearningWorkflowPipelineSetup
	for _, c := range []struct {
		from routetest.From
		key  string
		by   string
	}{
		{e.Window(), "viewkey", molten.LearningByView},
		{e.Terminal(), "agentkey", molten.LearningByAgent},
	} {
		data, errStr := routetest.Ask(t, link, c.from, molten.LearningRecordCommand, record(wf, c.key, "x"))
		if errStr != "" {
			t.Fatalf("record from %s: %s", c.from.Name, errStr)
		}
		var got molten.LearningRecorded
		if err := utilfn.ReUnmarshal(&got, data); err != nil || got.Item == nil || got.Item.Source.By != c.by {
			t.Fatalf("%s recorded as %+v (%v), want %s", c.from.Name, got, err, c.by)
		}
	}
}

func TestRouteScenario(t *testing.T) {
	e, link, _ := routeEnv(t)
	wf := molten.LearningWorkflowPipelineSetup
	ask := func(from routetest.From, command string, req molten.LearningRequest, out any) string {
		t.Helper()
		data, errStr := routetest.Ask(t, link, from, command, req)
		if errStr == "" && out != nil {
			if err := utilfn.ReUnmarshal(out, data); err != nil {
				t.Fatal(err)
			}
		}
		return errStr
	}
	agent, window := e.Terminal(), e.Window()

	for i := 0; i < 2; i++ {
		if errStr := ask(agent, molten.LearningRecordCommand, molten.LearningRequest{Workflow: wf, Kind: molten.LearningKindSkip, Key: "template"}, nil); errStr != "" {
			t.Fatal(errStr)
		}
	}
	if errStr := ask(agent, molten.LearningRecordCommand, molten.LearningRequest{Workflow: wf, Kind: molten.LearningKindCorrection, Key: "merge", Value: "squash", Proposed: "merge"}, nil); errStr != "" {
		t.Fatal(errStr)
	}
	var defaults molten.LearningDefaults
	if errStr := ask(agent, molten.LearningDefaultsCommand, molten.LearningRequest{Workflow: wf}, &defaults); errStr != "" {
		t.Fatal(errStr)
	}
	if len(defaults.Folded) != 1 || defaults.Folded[0].Key != "template" || len(defaults.Prefill) != 1 || defaults.Prefill[0].Value != "squash" {
		t.Fatalf("defaults: %+v", defaults)
	}

	var edited molten.LearningItem
	if errStr := ask(window, molten.LearningEditCommand, molten.LearningRequest{Workflow: wf, Id: "correction:merge", Value: "rebase"}, &edited); errStr != "" || edited.Value != "rebase" {
		t.Fatalf("edit: %+v %s", edited, errStr)
	}

	var all molten.LearningList
	if errStr := ask(agent, molten.LearningListCommand, molten.LearningRequest{}, &all); errStr != "" {
		t.Fatal(errStr)
	}
	if len(all.Workflows) != len(molten.LearningWorkflows) {
		t.Fatalf("every workflow is listed, those with nothing too: %+v", all)
	}
	for _, w := range all.Workflows {
		if w.Items == nil {
			t.Fatalf("an empty workflow lists no item, not null: %+v", w)
		}
	}
	var one molten.LearningList
	if errStr := ask(agent, molten.LearningListCommand, molten.LearningRequest{Workflow: wf}, &one); errStr != "" || len(one.Workflows) != 1 || len(one.Workflows[0].Items) != 2 {
		t.Fatalf("list of one workflow: %+v %s", one, errStr)
	}

	if errStr := ask(agent, molten.LearningForgetCommand, molten.LearningRequest{Workflow: wf, Id: "skip:template"}, nil); errStr != "" {
		t.Fatal(errStr)
	}
	if errStr := ask(agent, molten.LearningForgetCommand, molten.LearningRequest{Workflow: wf, Id: "skip:template"}, nil); !strings.Contains(errStr, "nothing learned") {
		t.Fatalf("forgetting twice: %q", errStr)
	}
	var reset map[string]int
	if errStr := ask(window, molten.LearningResetCommand, molten.LearningRequest{Workflow: wf}, &reset); errStr != "" || reset["forgotten"] != 1 {
		t.Fatalf("reset: %v %s", reset, errStr)
	}
	if errStr := ask(agent, molten.LearningDefaultsCommand, molten.LearningRequest{Workflow: "nope"}, nil); !strings.Contains(errStr, "unknown workflow") {
		t.Fatalf("unknown workflow: %q", errStr)
	}
}
