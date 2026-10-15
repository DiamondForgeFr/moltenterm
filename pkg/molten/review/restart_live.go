// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Restart is the developer's click on Restart work; the store's change goes to every Review tab of the PR.
func (s *Service) Restart(ctx context.Context, req RestartRequest) (RestartResult, error) {
	if s.restarter == nil {
		return RestartResult{}, fmt.Errorf("Restart work is not available")
	}
	result, err := s.restarter.Restart(ctx, req)
	if result.State != nil {
		s.changed(*result.State, true, nil)
	}
	return result, err
}

// AskRebase is the developer's click on Ask for a rebase in the Reviews list (#683).
func (s *Service) AskRebase(ctx context.Context, req RebaseRequest) (RestartResult, error) {
	if s.restarter == nil {
		return RestartResult{}, fmt.Errorf("Ask for a rebase is not available")
	}
	return s.restarter.AskRebase(ctx, req)
}

// liveRestartEnv: Mission Control's worktree terminals, the agent states, the guarded typing path of the handoffs and
// the review sessions' way of opening a terminal.
func liveRestartEnv(git reviewsession.GitRunner) RestartEnv {
	return RestartEnv{
		Git:       git,
		DataDir:   wavebase.GetWaveDataDir(),
		Terminals: mission.WorktreeTerminalsOf,
		IsReviewTerminal: func(ctx context.Context, blockId string) bool {
			block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
			return err == nil && block != nil && reviewsession.IsReviewBlock(block.Meta)
		},
		AgentRun: attention.AgentRun,
		TypePrompt: func(ctx context.Context, blockId string, line string) RestartTypeOutcome {
			out := termupdate.TypeHandoffLine(ctx, blockId, line)
			if out.Result == termupdate.InputSent {
				return RestartTypeOutcome{Sent: true, Submitted: out.Submitted, Message: out.Message}
			}
			switch out.Reason {
			case termupdate.InputReasonWorking, termupdate.InputReasonWaiting, termupdate.InputReasonBusy, termupdate.InputReasonNotForeground:
				return RestartTypeOutcome{Retry: true, Message: out.Message}
			}
			return RestartTypeOutcome{Message: out.Message}
		},
		OpenTerminal: reviewsession.OpenTerminal,
		AgentInstalled: func(agent string) bool {
			adapter := agentcontinuity.Find(agent)
			return adapter != nil && molten.LookPathIn(adapter.Executable(), molten.LoginPath()) != ""
		},
		AgentOrder:   agentcontinuity.Default().Ids(),
		SessionAgent: reviewsession.SessionAgent,
		Conventions: func(dir string) *molten.ProjectConventions {
			return molten.ReadProject(dir).Conventions
		},
	}
}
