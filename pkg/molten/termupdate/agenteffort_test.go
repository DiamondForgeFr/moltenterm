// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
)

var testCodexLevels = []string{"low", "medium", "high", "xhigh", "max"}

type effortTerm struct {
	*inputTerm
	remapped bool
	cleared  []string
}

func (f *effortTerm) env() Env {
	env := f.inputTerm.env()
	env.EffortLevels = func(agent string, model string) []string {
		if agent == molten.AgentIdCodex {
			if model == "gpt-test" {
				return testCodexLevels
			}
			return nil
		}
		return agentcontinuity.EffortLevels(molten.AgentEnv{}, agent, model)
	}
	env.EffortKeysRemapped = func(agent string) bool { return f.remapped }
	env.ClearEffort = func(blockId string, agent string) { f.cleared = append(f.cleared, blockId+":"+agent) }
	return env
}

func claudeEffortTerm(effort string) *effortTerm {
	f := &effortTerm{inputTerm: claudeInputTerm()}
	f.run.Settings = molten.AgentSettings{Model: "claude-opus-5-5", ModelName: "Opus", Effort: effort}
	return f
}

func codexEffortTerm(effort string) *effortTerm {
	f := &effortTerm{inputTerm: claudeInputTerm()}
	f.procs[1].Name = "codex"
	f.run.Agent = "codex"
	f.run.Settings = molten.AgentSettings{Model: "gpt-test", Effort: effort}
	return f
}

func askEffort(f *effortTerm, agent string, effort string) AgentInputResult {
	return MakeUpdater(f.env()).AgentInput(context.Background(), AgentInputRequest{BlockId: "b1", Agent: agent, Action: agentcontinuity.ActionEffort, Effort: effort})
}

func TestClaudeEffortTypesTheSlashCommand(t *testing.T) {
	f := claudeEffortTerm("medium")
	out := askEffort(f, "claude", "high")
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/effort high|\r" || out.Effort != "high" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	if len(f.cleared) != 0 {
		t.Fatalf("Claude Code's status line reports the new level, nothing to clear: %v", f.cleared)
	}
}

func TestClaudeEffortRefusals(t *testing.T) {
	f := claudeEffortTerm("medium")
	if out := askEffort(f, "claude", "ultra"); out.Reason != InputReasonUnknownAction || len(f.input) != 0 {
		t.Fatalf("an unknown level is never typed: %+v %q", out, f.input)
	}
	if out := askEffort(f, "claude", "medium"); out.Result != InputSent || len(f.input) != 0 {
		t.Fatalf("the level in effect types nothing: %+v %q", out, f.input)
	}
	f.state.Draft = true
	if out := askEffort(f, "claude", "high"); out.Reason != InputReasonDraft || len(f.input) != 0 {
		t.Fatalf("a draft asks first: %+v %q", out, f.input)
	}
	f.state.Draft = false
	f.run.State = molten.AgentStateWorking
	if out := askEffort(f, "claude", "high"); out.Reason != InputReasonWorking || len(f.input) != 0 {
		t.Fatalf("not while working: %+v %q", out, f.input)
	}
}

func TestClaudeEffortWithoutXHighOnOpus46(t *testing.T) {
	f := claudeEffortTerm("high")
	f.run.Settings.Model = "claude-opus-4-6"
	if out := askEffort(f, "claude", "xhigh"); out.Reason != InputReasonUnknownAction || len(f.input) != 0 {
		t.Fatalf("Opus 4.6 has no xhigh: %+v", out)
	}
	info := MakeUpdater(f.env()).AgentInputInfo("b1")
	if slices.Contains(info.Efforts, "xhigh") || !slices.Contains(info.Efforts, "max") || info.Effort != "high" {
		t.Fatalf("info: %+v", info)
	}
}

func TestCodexEffortPressesTheKeysFromTheKnownLevel(t *testing.T) {
	f := codexEffortTerm("medium")
	out := askEffort(f, "codex", "xhigh")
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x1b[1;2A|\x1b[1;2A" || out.Presses != 2 {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	if !slices.Equal(f.cleared, []string{"b1:codex"}) {
		t.Fatalf("the header shows no effort until Codex's next turn: %v", f.cleared)
	}
	f.input, f.cleared = nil, nil
	f.run.Settings.Effort = "max"
	out = askEffort(f, "codex", "low")
	if out.Result != InputSent || strings.Join(f.input, "|") != strings.Repeat("\x1b[1;2B|", 3)+"\x1b[1;2B" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestCodexEffortNeedsAKnownLevel(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(f *effortTerm)
	}{
		{"no turn yet", func(f *effortTerm) { f.run.Settings.Effort = "" }},
		{"a level outside the model's", func(f *effortTerm) { f.run.Settings.Effort = "ultra" }},
		{"keys moved", func(f *effortTerm) { f.remapped = true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := codexEffortTerm("medium")
			tc.setup(f)
			out := askEffort(f, "codex", "high")
			if out.Result != InputRefused || len(f.input) != 0 {
				t.Fatalf("got %+v, typed %q", out, f.input)
			}
			if info := MakeUpdater(f.env()).AgentInputInfo("b1"); len(info.Efforts) != 0 {
				t.Fatalf("no levels offered: %+v", info)
			}
		})
	}
	f := codexEffortTerm("medium")
	if out := askEffort(f, "codex", "ultra"); out.Reason != InputReasonUnknownAction || len(f.input) != 0 {
		t.Fatalf("ultra needs Codex's picker: %+v", out)
	}
}

func TestCodexEffortGoesThroughWithADraft(t *testing.T) {
	f := codexEffortTerm("low")
	f.state.Draft = true
	if out := askEffort(f, "codex", "medium"); out.Result != InputSent || len(f.input) != 1 {
		t.Fatalf("the effort keys leave the input line alone: %+v %q", out, f.input)
	}
}
