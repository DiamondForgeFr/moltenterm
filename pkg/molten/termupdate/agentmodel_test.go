// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
)

func TestClaudeModelTypesTheAlias(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "sonnet"})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/model sonnet|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestModelWithoutAliasOpensThePicker(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionModel})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/model|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestModelRefusals(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(f *inputTerm)
		req    AgentInputRequest
		reason string
	}{
		{"not an alias", nil, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "opus; rm -rf ~"}, InputReasonUnknownAction},
		{"a full id is not offered", nil, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "claude-opus-5-5"}, InputReasonUnknownAction},
		{"a model on another action", nil, AgentInputRequest{Action: agentcontinuity.ActionClear, Model: "opus"}, InputReasonUnknownAction},
		{"working", func(f *inputTerm) { f.run.State = molten.AgentStateWorking }, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "opus"}, InputReasonWorking},
		{"waiting", func(f *inputTerm) { f.run.State = molten.AgentStateWaiting }, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "opus"}, InputReasonWaiting},
		{"draft", func(f *inputTerm) { f.state.Draft = true }, AgentInputRequest{Action: agentcontinuity.ActionModel, Model: "opus"}, InputReasonDraft},
	}
	for _, c := range cases {
		f := claudeInputTerm()
		if c.setup != nil {
			c.setup(f)
		}
		out := ask(f, c.req)
		if out.Reason != c.reason || len(f.input) != 0 {
			t.Fatalf("%s: got %+v, typed %q", c.name, out, f.input)
		}
	}
}

func TestCodexModelIsItsPickerOnly(t *testing.T) {
	f := claudeInputTerm()
	f.procs[1].Name = "codex"
	f.run.Agent = "codex"
	out := ask(f, AgentInputRequest{Agent: "codex", Action: agentcontinuity.ActionModel, Model: "gpt-test"})
	if out.Reason != InputReasonUnknownAction || len(f.input) != 0 {
		t.Fatalf("Codex's /model takes no argument: %+v %q", out, f.input)
	}
	if info := MakeUpdater(f.env()).AgentInputInfo("b1"); len(info.Models) != 0 {
		t.Fatalf("no models offered for Codex: %+v", info)
	}
}

func TestInfoOffersClaudeAliases(t *testing.T) {
	f := claudeInputTerm()
	info := MakeUpdater(f.env()).AgentInputInfo("b1")
	var ids []string
	for _, m := range info.Models {
		ids = append(ids, m.Id)
	}
	if strings.Join(ids, ",") != "fable,opus,sonnet,haiku" {
		t.Fatalf("aliases: %v", ids)
	}
}
