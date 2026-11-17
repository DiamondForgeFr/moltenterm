// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"context"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// What the setup and the hand-off reach in wavesrv (#2251): the login shell's PATH for SaaSFoundryAI's command, the
// coding agent chosen for the folder (agentchoice, #845), and the tabs and terminals Restart work opens
// (wcore.CreateAgentTab, reviewsession.OpenTerminal).

// liveFindSf looks SaaSFoundryAI's command up on the login PATH, read again on Check again: an installer may have
// added its folder since. Only its own name counts, never a bare `sf`.
func liveFindSf(refresh bool) string {
	path := molten.LoginPath()
	if refresh {
		path = molten.RefreshLoginPath()
	}
	if molten.LookPathIn(SfProgram, path) == "" {
		return ""
	}
	return SfProgram
}

func liveResolveAgent(dir string, run string) AgentPick {
	choice := agentchoice.Resolve(dir, run)
	pick := AgentPick{Agent: choice.Agent, AgentName: choice.AgentName, Missing: choice.Missing, Chosen: choice.Chosen, ChosenName: choice.ChosenName}
	for _, a := range choice.Agents {
		pick.Agents = append(pick.Agents, HandoffAgent{Id: a.Id, Name: a.Name, Installed: a.Installed})
	}
	return pick
}

// launchPlaced: the launch's terminal is one of its tab's blocks, and that tab one of its workspace's. A terminal moved
// to another tab, or a tab moved to another workspace, is no longer the one the click opened there.
func launchPlaced(launch Launch, tabBlocks []string, workspaceTabs []string) bool {
	return slices.Contains(tabBlocks, launch.Block) && slices.Contains(workspaceTabs, launch.Tab)
}

func liveLaunchAlive(ctx context.Context, launch Launch) bool {
	block, err := wstore.DBGet[*waveobj.Block](ctx, launch.Block)
	if err != nil || block == nil {
		return false
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, launch.Tab)
	if err != nil || tab == nil {
		return false
	}
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, launch.Workspace)
	if err != nil || ws == nil {
		return false
	}
	return launchPlaced(launch, tab.BlockIds, ws.TabIds)
}

func liveLaunchEnv(handoffDir string) LaunchEnv {
	return LaunchEnv{
		FindSf:       liveFindSf,
		Run:          mission.ExecRunner,
		ResolveAgent: liveResolveAgent,
		AgentTab:     wcore.CreateAgentTab,
		CloseTab:     wcore.CloseAgentTab,
		OpenTerminal: reviewsession.OpenTerminal,
		LaunchAlive:  liveLaunchAlive,
		HandoffDir:   handoffDir,
	}
}
