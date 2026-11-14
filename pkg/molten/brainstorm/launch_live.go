// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"context"

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

func liveBlockExists(ctx context.Context, blockId string) bool {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	return err == nil && block != nil
}

func liveLaunchEnv(handoffDir string) LaunchEnv {
	return LaunchEnv{
		FindSf:       liveFindSf,
		Run:          mission.ExecRunner,
		ResolveAgent: liveResolveAgent,
		AgentTab:     wcore.CreateAgentTab,
		CloseTab:     wcore.CloseAgentTab,
		OpenTerminal: reviewsession.OpenTerminal,
		BlockExists:  liveBlockExists,
		HandoffDir:   handoffDir,
	}
}
