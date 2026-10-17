// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// liveFollowEvery: how often an agent MoltenTerm started is read on its way to its clean end (agentfollow.go); while
// it works only its in-memory state is.
const liveFollowEvery = 5 * time.Second

// Restart is the developer's click on Restart work; the store's change goes to every Review tab of the PR.
func (s *Service) Restart(ctx context.Context, req RestartRequest) (RestartResult, error) {
	if s.restarter == nil {
		return RestartResult{}, uimsg.Errorf(uimsg.Make("review.restartunavailable"), "Restart work is not available")
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
		return RestartResult{}, rebaseUnavailableError()
	}
	return s.restarter.AskRebase(ctx, req)
}

func (s *Service) AskInvestigate(ctx context.Context, req InvestigateRequest) (RestartResult, error) {
	if s.restarter == nil {
		return RestartResult{}, rebaseUnavailableError()
	}
	return s.restarter.AskInvestigate(ctx, req)
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
		OpenTerminal:   reviewsession.OpenTerminal,
		AgentInstalled: agentchoice.Installed,
		AgentOrder:     agentcontinuity.Default().Ids(),
		SessionAgent:   reviewsession.SessionAgent,
		GlobalAgent:    agentchoice.Live().Global,
		ProjectAgent:   agentchoice.Live().Project,
		Conventions: func(dir string) *molten.ProjectConventions {
			return molten.ReadProject(dir).Conventions
		},
		AgentTab:    wcore.CreateAgentTab,
		CloseTab:    wcore.CloseAgentTab,
		FollowEvery: liveFollowEvery,
		BlockExists: func(ctx context.Context, blockId string) bool {
			block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
			return err == nil && block != nil
		},
		CloseTerminal: wcore.CloseAgentTerminal,
		Notify:        attention.PublishNotification,
		ResolveNotices: func(ctx context.Context, keyPrefix string) error {
			return attention.ResolveNotificationsExcept(ctx, keyPrefix, nil)
		},
		Gh:           ExecGh,
		HoldState:    attention.HoldAgentState,
		ReleaseState: attention.ReleaseAgentState,
	}
}
