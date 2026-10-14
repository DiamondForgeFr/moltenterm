// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

var localCommands = []string{
	GetCommand, RefreshCommand, RunCommand, RunsCommand, LogCommand, CancelCommand, CloseCommand, CiStateCommand, CiRunCommand,
	CiLogCommand, CiCancelCommand, CiStatusCommand, BuildsCommand, ReleaseCommand, ReleaseEndCommand, ReleaseFactsCommand,
	ReleaseNotesCommand, ReleaseMilestoneCommand, BranchesPlanCommand, WorkCommand, SpawnsCommand, JobsCommand, DepsCommand,
	DepSyncCommand, GroupsCommand, GithubRunLogCommand, PaneCommand, ReviewsCommand, WorktreePlanCommand,
}

// #662: a remote host, forging a window's source or not, runs nothing here: not a project's commands, its CI or a
// release step (the scenario: run an untrusted project, read its hash, trust it with a forged tab source, run its
// commands), nor reads the reviews (FR-REV-014 AC4). Every decision of the user's is a window's only.
func TestRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{}).route())
	if err != nil {
		t.Fatal(err)
	}
	req := map[string]any{"dir": t.TempDir(), "hash": "h", "id": "build", "kind": RunKindBuild, "tag": "v1", "text": "notes"}
	for command := range windowCommands {
		routetest.MustRefuseWith(t, link, e.NonWindows(), command, req, "from a MoltenTerm window")
	}
	for _, command := range localCommands {
		routetest.MustRefuse(t, link, e.NonLocal(), command, req)
	}
}
