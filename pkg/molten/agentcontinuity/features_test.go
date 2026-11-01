// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-AGC-001: every agent MoltenTerm knows has one row, every row declares every feature and passes the checks.
func TestFeatureMatrixCoversEveryAgent(t *testing.T) {
	m := Default().Matrix()
	if m.AsOf != MatrixAsOf || len(m.Features) != len(AllFeatures) {
		t.Fatalf("matrix header %q, %d features", m.AsOf, len(m.Features))
	}
	var ids []string
	rows := map[string]AgentFeatures{}
	for _, a := range m.Agents {
		ids = append(ids, a.Id)
		rows[a.Id] = a
	}
	want := []string{molten.AgentIdClaude, molten.AgentIdCodex, molten.AgentIdGemini, molten.AgentIdKimi, molten.AgentIdQwen, molten.AgentIdOpenCode,
		molten.AgentIdAntigravity, molten.AgentIdCopilot, molten.AgentIdCursor, molten.AgentIdGrok, molten.AgentIdVibe}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("matrix agents %v, want %v", ids, want)
	}
	// An agent added to molten.AgentKinds (#1680) needs its row: an adapter or a PlannedAgents entry.
	for _, kind := range molten.AgentKinds {
		if _, ok := rows[kind.Id]; !ok {
			t.Errorf("agent %s of molten.AgentKinds has no row in the compatibility matrix", kind.Id)
		}
	}
	for _, a := range m.Agents {
		var caps map[string]Capability
		if adapter := Find(a.Id); adapter != nil {
			caps = adapter.Capabilities()
		}
		if a.Adapter != (caps != nil) {
			t.Errorf("%s: adapter %v", a.Id, a.Adapter)
		}
		if err := checkFeatures(a.Id, a.Features, caps); err != nil {
			t.Error(err)
		}
	}
	seen := map[string]bool{}
	for _, f := range AllFeatures {
		if seen[f.Id] || strings.TrimSpace(f.Name) == "" {
			t.Errorf("feature %q duplicated or unnamed", f.Id)
		}
		seen[f.Id] = true
		for _, req := range f.Requires {
			if !strings.Contains(" "+strings.Join(AllCapabilities, " ")+" ", " "+req+" ") {
				t.Errorf("feature %s requires unknown capability %s", f.Id, req)
			}
		}
	}
}

// The cells of the #1681 audit that tell the agents apart.
func TestFeatureMatrixCells(t *testing.T) {
	rows := map[string]map[string]FeatureSupport{}
	for _, a := range Default().Matrix().Agents {
		rows[a.Id] = a.Features
	}
	cases := []struct {
		agent, feature, level, reason string
	}{
		{"claude", FeatState, LevelNative, ""},
		{"claude", FeatBrowserMcp, LevelAdapted, ""},
		{"claude", FeatModParts, LevelNative, ""},
		{"codex", FeatState, LevelAdapted, ""},
		{"codex", FeatStatusLine, LevelNone, ReasonAgentSpecific},
		{"codex", FeatResume, LevelNative, ""},
		{"codex", FeatWorktreeName, LevelProcessOnly, ReasonAgentSpecific},
		{"gemini", FeatState, LevelProcessOnly, ReasonNoHooks},
		{"gemini", FeatGuides, LevelAdapted, ""},
		{"gemini", FeatBrowserMcp, LevelNone, ReasonNoAdapter},
		{"kimi", FeatDetect, LevelProcessOnly, ReasonNoAdapter},
		{"copilot", FeatGuides, LevelAdapted, ""},
		{"cursor", FeatResume, LevelNone, ReasonNoAdapter},
		{"kimi", FeatBusyClose, LevelProcessOnly, ReasonNoHooks},
		{"opencode", FeatGuides, LevelNone, ReasonNoSkills},
		{"opencode", FeatDetect, LevelProcessOnly, ReasonNoAdapter},
	}
	for _, c := range cases {
		got := rows[c.agent][c.feature]
		if got.Level != c.level || got.Reason != c.reason {
			t.Errorf("%s %s: %s (%s), want %s (%s)", c.agent, c.feature, got.Level, got.Reason, c.level, c.reason)
		}
	}
}

// The Codex hooks note said hooks "are not added" after #988 added them (#1681 audit).
func TestCodexHooksNote(t *testing.T) {
	note := Find(molten.AgentIdCodex).Capabilities()[CapHooks].Note
	if strings.Contains(note, "not added") || !strings.Contains(note, "/hooks") || !strings.Contains(note, "PermissionRequest") {
		t.Errorf("codex hooks note: %q", note)
	}
}

func TestFeaturesReturnsCopies(t *testing.T) {
	for _, a := range Default().Adapters() {
		f := a.Features()
		f[FeatDetect] = FeatureSupport{}
		if a.Features()[FeatDetect].Level == "" {
			t.Errorf("%s: Features returns its own map", a.Id())
		}
	}
	m := Default().Matrix()
	m.Agents[2].Features[FeatDetect] = FeatureSupport{}
	if PlannedAgents[0].Features[FeatDetect].Level == "" {
		t.Error("Matrix returns a planned agent's own map")
	}
}

// TC-AGC-001: a row the interface could not trust is refused.
func TestCheckFeaturesRefuses(t *testing.T) {
	caps := Find(molten.AgentIdClaude).Capabilities()
	cases := []struct {
		name   string
		change func(f map[string]FeatureSupport, c map[string]Capability)
		caps   bool
		want   string
	}{
		{"missing", func(f map[string]FeatureSupport, c map[string]Capability) { delete(f, FeatHandoff) }, true, "handoff not declared"},
		{"extra", func(f map[string]FeatureSupport, c map[string]Capability) {
			f["teleport"] = FeatureSupport{Level: LevelNone, Reason: ReasonNoAdapter}
		}, true, "unknown features"},
		{"level", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: "mostly", Adapter: "x"}
		}, true, `level "mostly"`},
		{"reason", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: LevelNone, Reason: "tired"}
		}, true, `reason "tired"`},
		{"none without reason", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: LevelNone}
		}, true, "without a reason"},
		{"process-only without reason", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: LevelProcessOnly, Adapter: "x"}
		}, true, "without a reason"},
		{"adapted without note", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: LevelAdapted, Adapter: "x"}
		}, true, "without a note"},
		{"native without adapter", func(f map[string]FeatureSupport, c map[string]Capability) {
			f[FeatState] = FeatureSupport{Level: LevelNative}
		}, true, "without its adapter"},
		{"capability unavailable", func(f map[string]FeatureSupport, c map[string]Capability) {
			c[CapMcp] = Capability{Support: SupportUnavailable}
		}, true, "browsermcp is adapted but capability mcp is unavailable"},
		{"planned native", func(f map[string]FeatureSupport, c map[string]Capability) {}, false, "native but the agent has no adapter"},
	}
	for _, tc := range cases {
		f := Find(molten.AgentIdClaude).Features()
		c := copyCapabilities(caps)
		tc.change(f, c)
		if !tc.caps {
			c = nil
		}
		err := checkFeatures("claude", f, c)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	// A none cell may stand without its capability.
	f := Find(molten.AgentIdClaude).Features()
	f[FeatBrowserMcp] = FeatureSupport{Level: LevelNone, Reason: ReasonNoMcp}
	f[FeatInstructions] = FeatureSupport{Level: LevelNone, Reason: ReasonNoMcp}
	f[FeatReviewSession] = FeatureSupport{Level: LevelNone, Reason: ReasonNoMcp}
	c := copyCapabilities(caps)
	c[CapMcp] = Capability{Support: SupportUnavailable}
	if err := checkFeatures("claude", f, c); err != nil {
		t.Errorf("none cells without the capability: %v", err)
	}
}

type featuresAdapter struct {
	claudeAdapter
	features map[string]FeatureSupport
}

func (f featuresAdapter) Features() map[string]FeatureSupport {
	return f.features
}

func TestMakeRegistryRefusesBadFeatures(t *testing.T) {
	features := Find(molten.AgentIdClaude).Features()
	delete(features, FeatTermCopy)
	if _, err := MakeRegistry(featuresAdapter{features: features}); err == nil || !strings.Contains(err.Error(), "termcopy not declared") {
		t.Errorf("adapter without a feature: %v", err)
	}
	r, err := MakeRegistry(claudeAdapter{}, codexAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	if err := checkPlanned(r, PlannedAgents); err != nil {
		t.Errorf("builtin planned agents: %v", err)
	}
	if err := checkPlanned(r, []PlannedAgent{{Id: "aider", Features: geminiFeatures}}); err == nil || !strings.Contains(err.Error(), "not an agent id") {
		t.Errorf("unknown planned id: %v", err)
	}
	if err := checkPlanned(r, []PlannedAgent{{Id: molten.AgentIdCodex, Features: geminiFeatures}}); err == nil || !strings.Contains(err.Error(), "already has an adapter") {
		t.Errorf("planned agent with an adapter: %v", err)
	}
	if err := checkPlanned(r, []PlannedAgent{{Id: molten.AgentIdGemini}}); err == nil || !strings.Contains(err.Error(), "not declared") {
		t.Errorf("planned agent without a row: %v", err)
	}
}

// DS-AGC-002: the route answers the matrix, with lowercase fields and the levels' words.
func TestFeaturesRoute(t *testing.T) {
	got, err := handleFeatures(FeaturesGetCommand)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"asof":"` + MatrixAsOf + `"`, `"id":"claude"`, `"adapter":true`, `"level":"process-only"`, `"reason":"noskills"`, `"requires":["hooks"]`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("route answer misses %s", want)
		}
	}
	if _, err := handleFeatures("moltenagentteleport"); err == nil {
		t.Error("unknown command accepted")
	}
}
