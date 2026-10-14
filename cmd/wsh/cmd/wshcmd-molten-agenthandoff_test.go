// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

func TestMoltenSendFileRef(t *testing.T) {
	for arg, want := range map[string]handoffwire.FileRef{
		"/a/b.go":        {Path: "/a/b.go"},
		"/a/b.go:40-60":  {Path: "/a/b.go", Lines: "40-60"},
		"/a/b.go:7":      {Path: "/a/b.go", Lines: "7"},
		"/a/odd:name.go": {Path: "/a/odd:name.go"},
	} {
		if got := moltenSendFileRef(arg); got != want {
			t.Errorf("%s: %+v", arg, got)
		}
	}
}

func TestMoltenBuildSendBrief(t *testing.T) {
	defer func() {
		moltenAgentSendGoal, moltenAgentSendContext, moltenAgentSendBrief = "", "", ""
		moltenAgentSendFiles, moltenAgentSendLinks, moltenAgentSendTabs, moltenAgentSendReply = nil, nil, nil, false
	}()
	moltenAgentSendBrief = "-"
	moltenAgentSendFiles = []string{"/p/x.go:3-4"}
	moltenAgentSendTabs = []int64{2}
	moltenAgentSendReply = true
	brief, err := moltenBuildSendBrief(strings.NewReader(`{"goal":"from json","links":[{"url":"https://x.dev","kind":"pr"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if brief.Goal != "from json" || !brief.Reply || len(brief.Files) != 1 || brief.Files[0].Lines != "3-4" ||
		len(brief.Links) != 2 || brief.Links[1].TabId != 2 || brief.Links[1].Kind != handoffwire.LinkKindBrowser {
		t.Fatalf("%+v", brief)
	}
	moltenAgentSendBrief = ""
	moltenAgentSendGoal = ""
	if _, err := moltenBuildSendBrief(strings.NewReader("")); err == nil {
		t.Fatal("a brief needs a goal")
	}
}

func TestFormatMoltenActiveAgents(t *testing.T) {
	text := formatMoltenActiveAgents(handoffwire.ListResult{Agents: []handoffwire.AgentEntry{
		{FirstName: "Camille", AgentName: "Claude Code", State: "idle", Project: "a", Workspace: "A", Tab: "T", You: true},
		{FirstName: "Jérôme", AgentName: "Codex"},
	}})
	if !strings.Contains(text, "Camille (you)") || !strings.Contains(text, "Jérôme") || !strings.HasPrefix(text, "NAME") {
		t.Fatalf("%s", text)
	}
	if formatMoltenActiveAgents(handoffwire.ListResult{}) != "No agent is running in MoltenTerm.\n" {
		t.Fatal("empty list")
	}
}
