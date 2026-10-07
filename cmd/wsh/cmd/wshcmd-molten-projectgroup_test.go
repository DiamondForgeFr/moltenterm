// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestMoltenProjectGroupRouting(t *testing.T) {
	for _, line := range []string{"molten project group", "molten project group --json"} {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil || found.Name() != "group" {
			t.Fatalf("%q: %v, %v", line, found, err)
		}
	}
}

func TestFormatMoltenProjectGroup(t *testing.T) {
	status := MoltenProjectGroupStatus{
		Linked:  true,
		Dir:     "/p/app",
		Project: "Notulia",
		Group: &moltenGroup{
			Key:   "notulia",
			Name:  "Notulia",
			Worst: moltenGroupWorstRed,
			Members: []moltenGroupMember{
				{
					GroupMember: molten.GroupMember{Dir: "/p/app", Name: "Notulia", Workspaces: []molten.GroupWorkspace{{Id: "a", Name: "App"}}},
					State:       moltenGroupMemberState{CollectedAt: 1, Trunk: "develop", TrunkCi: "success", RemoteCi: "failure", Build: "success", BuildId: "gold", ReleaseTag: "v1.2.0", LastTag: "v1.3.0-1", Worst: moltenGroupWorstRed},
					Current:     true,
				},
				{
					GroupMember: molten.GroupMember{Dir: "/p/site", Name: "notulia-website", Workspaces: []molten.GroupWorkspace{{Id: "s", Name: "Site"}, {Id: "u"}}},
				},
			},
		},
	}
	text := formatMoltenProjectGroup(status)
	for _, want := range []string{
		"Notulia: 2 members (red: a CI or a build failed)",
		"  Notulia (this workspace)\n    workspace: App\n    folder: /p/app\n",
		"local CI green on develop, GitHub CI red on develop, last build gold success, release v1.2.0, newest tag v1.3.0-1; red",
		"    workspaces: Site, unsaved workspace\n",
		"not read yet (open the Project tab of its workspace)",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if text := formatMoltenProjectGroup(MoltenProjectGroupStatus{Linked: true, Project: "MoltenTerm"}); !strings.Contains(text, "MoltenTerm is in no group") {
		t.Errorf("ungrouped: %s", text)
	}
	if text := formatMoltenProjectGroup(MoltenProjectGroupStatus{Linked: true, Project: "site", Declared: "Notulia", Dir: "/p/app/site"}); !strings.Contains(text, "not read as a member") {
		t.Errorf("nested: %s", text)
	}
	if text := formatMoltenProjectGroup(MoltenProjectGroupStatus{}); !strings.Contains(text, "not linked") {
		t.Errorf("unlinked: %s", text)
	}
}

func TestFormatMoltenProjectShowsGroup(t *testing.T) {
	status := MoltenProjectStatus{Linked: true, Project: &molten.ProjectInfo{Dir: "/p/app", Name: "Notulia", Exists: true, Group: "Notulia"}}
	if text := formatMoltenProjectDetails(status); !strings.Contains(text, "  group: Notulia (its members: molten project group)\n") {
		t.Errorf("show: %s", text)
	}
	summary := formatMoltenPipelineSummary(&molten.Pipeline{Group: "Notulia", DependsOn: []molten.PipelineDependency{{Project: "x"}}})
	if !strings.HasSuffix(summary, "group Notulia, 1 dependency") {
		t.Errorf("summary: %s", summary)
	}
}
