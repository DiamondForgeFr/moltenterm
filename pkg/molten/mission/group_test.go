// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestTrunkRemoteCi(t *testing.T) {
	runs := json.RawMessage(`[
	  {"headBranch": "feature/9-x", "headSha": "f", "status": "completed", "conclusion": "failure", "url": "u-f"},
	  {"headBranch": "develop", "headSha": "b", "status": "completed", "conclusion": "success", "url": "u-b1"},
	  {"headBranch": "develop", "headSha": "b", "status": "in_progress", "conclusion": "", "url": "u-b2"},
	  {"headBranch": "develop", "headSha": "a", "status": "completed", "conclusion": "failure", "url": "u-a"}
	]`)
	if state, url := trunkRemoteCi(runs, "develop"); state != CiStateRunning || url != "u-b2" {
		t.Fatalf("the newest trunk commit is still running: %s %s", state, url)
	}
	failed := json.RawMessage(`[
	  {"headBranch": "develop", "headSha": "b", "status": "completed", "conclusion": "success", "url": "u-1"},
	  {"headBranch": "develop", "headSha": "b", "status": "completed", "conclusion": "timed_out", "url": "u-2"}
	]`)
	if state, url := trunkRemoteCi(failed, "develop"); state != CiStateFailure || url != "u-2" {
		t.Fatalf("one failed run makes the trunk red: %s %s", state, url)
	}
	cancelled := json.RawMessage(`[{"headBranch": "develop", "headSha": "b", "status": "completed", "conclusion": "cancelled"}]`)
	if state, _ := trunkRemoteCi(cancelled, "develop"); state != "" {
		t.Fatalf("a cancelled run is not red: %q", state)
	}
	if state, _ := trunkRemoteCi(nil, "develop"); state != "" {
		t.Fatal("no runs")
	}
}

func TestMemberWorst(t *testing.T) {
	cases := []struct {
		state GroupMemberState
		want  string
	}{
		{GroupMemberState{TrunkCi: CiStateSuccess, RemoteCi: CiStateSuccess, Build: RunStateSuccess}, ""},
		{GroupMemberState{TrunkCi: CiStateRunning, Build: RunStateRunning}, ""},
		{GroupMemberState{TrunkCi: CiStateFailure}, GroupWorstRed},
		{GroupMemberState{RemoteCi: CiStateFailure}, GroupWorstRed},
		{GroupMemberState{Build: RunStateFailure}, GroupWorstRed},
		{GroupMemberState{Build: RunStateCancelled}, ""},
	}
	for _, c := range cases {
		if got := memberWorst(c.state); got != c.want {
			t.Errorf("%+v: got %q, want %q", c.state, got, c.want)
		}
	}
	if worstOf("", GroupWorstAmber) != GroupWorstAmber || worstOf(GroupWorstAmber, GroupWorstRed) != GroupWorstRed || worstOf("", "") != "" {
		t.Fatal("worstOf")
	}
}

func groupProject(name string, group string) func(dir string) molten.ProjectInfo {
	return func(dir string) molten.ProjectInfo {
		return molten.ProjectInfo{Dir: dir, Name: name, Exists: true, GitRoot: dir, HasPipeline: true, Group: group}
	}
}

func TestGroupsGet(t *testing.T) {
	app, site, molt := "/p/app", "/p/site", "/p/molten"
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{
		Dir:   app,
		GitAt: 1000,
		Git: &GitSnapshot{
			Trunk:      "develop",
			Branches:   []Branch{{Name: "main", Sha: "m"}, {Name: "develop", Sha: "d"}},
			Tags:       []Tag{{Name: "v1.3.0-1"}, {Name: "v1.2.0"}},
			LastPublic: "v1.2.0",
		},
		Github: &GithubSnapshot{Runs: json.RawMessage(`[{"headBranch": "develop", "headSha": "d", "status": "completed", "conclusion": "failure", "url": "u"}]`)},
	})
	projects := map[string]func(string) molten.ProjectInfo{
		app:  groupProject("Notulia", "Notulia"),
		site: groupProject("notulia-website", "notulia"),
		molt: groupProject("MoltenTerm", ""),
	}
	var published []GroupsAnswer
	groups := MakeGroups(collector, nil, nil, nil, func(ctx context.Context) ([]molten.GroupLink, error) {
		return []molten.GroupLink{
			{WorkspaceId: "w-app", WorkspaceName: "App", Dir: app},
			{WorkspaceId: "w-molten", WorkspaceName: "MoltenTerm", Dir: molt},
			{WorkspaceId: "w-site", WorkspaceName: "Site", Dir: site},
		}, nil
	}, func(answer GroupsAnswer) { published = append(published, answer) }, nil)
	groups.read = func(dir string) molten.ProjectInfo { return projects[dir](dir) }

	answer, err := groups.Get(GroupsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Groups) != 1 || answer.Groups[0].Name != "Notulia" || len(answer.Groups[0].Members) != 2 {
		t.Fatalf("groups: %+v", answer)
	}
	appState := answer.Groups[0].Members[0].State
	if appState.Trunk != "develop" || appState.TrunkSha != "d" || appState.RemoteCi != CiStateFailure || appState.ReleaseTag != "v1.2.0" || appState.LastTag != "v1.3.0-1" || appState.Worst != GroupWorstRed {
		t.Fatalf("app state: %+v", appState)
	}
	if siteState := answer.Groups[0].Members[1].State; siteState.CollectedAt != 0 || siteState.Worst != "" {
		t.Fatalf("a member never collected has no state yet: %+v", siteState)
	}
	if answer.Groups[0].Worst != GroupWorstRed {
		t.Fatalf("group worst: %q", answer.Groups[0].Worst)
	}

	only, err := groups.Get(GroupsRequest{Dir: site})
	if err != nil || len(only.Groups) != 1 || only.Groups[0].Key != "notulia" {
		t.Fatalf("the group of the site: %+v, %v", only, err)
	}
	none, err := groups.Get(GroupsRequest{Dir: molt})
	if err != nil || len(none.Groups) != 0 {
		t.Fatalf("an ungrouped project has no group: %+v, %v", none, err)
	}
	if _, err := groups.Get(GroupsRequest{Dir: "relative"}); err == nil {
		t.Fatal("a relative folder must be refused")
	}

	groups.Refreshed()
	groups.Refreshed()
	if len(published) != 1 {
		t.Fatalf("an unchanged model is published once: %d", len(published))
	}
	projects[site] = groupProject("notulia-website", "")
	groups.Refreshed()
	if len(published) != 2 || len(published[1].Groups[0].Members) != 1 {
		t.Fatalf("a member that removed its group is out at the next refresh: %+v", published)
	}
}
