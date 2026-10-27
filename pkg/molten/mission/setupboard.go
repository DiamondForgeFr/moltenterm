// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The setup's agent board on the route (FR-MC-045, #1163). The agent's commands (`molten pipeline setup`) are answered
// to local terminals only, for the setup of the project their own tab sets up: the router proves the terminal's block
// from its token, the block gives its tab, and the pipeline tab's meta gives the project (#1150). The agent never names
// a folder. The panel's commands (its context, the developer's decisions, the draft with the accepted changes) are a
// MoltenTerm window's only.

const (
	SetupBoardEvent = "molten:pipelinesetup:board"

	SetupAgentShowCommand     = "moltenmissionsetupagentshow"
	SetupAgentProposeCommand  = "moltenmissionsetupagentpropose"
	SetupAgentFlagCommand     = "moltenmissionsetupagentflag"
	SetupAgentExplainCommand  = "moltenmissionsetupagentexplain"
	SetupAgentWithdrawCommand = "moltenmissionsetupagentwithdraw"

	SetupBoardOpenCommand   = "moltenmissionsetupboardopen"
	SetupBoardCloseCommand  = "moltenmissionsetupboardclose"
	SetupBoardStateCommand  = "moltenmissionsetupboardstate"
	SetupBoardDecideCommand = "moltenmissionsetupboarddecide"
	SetupBoardApplyCommand  = "moltenmissionsetupboardapply"
	// "Apply to the other channel too": the open change proposed again for the other channel's same step.
	SetupBoardCopyCommand = "moltenmissionsetupboardcopy"

	setupBoardTimeout = 10 * time.Second
)

var setupAgentCommands = map[string]bool{
	SetupAgentShowCommand: true, SetupAgentProposeCommand: true, SetupAgentFlagCommand: true,
	SetupAgentExplainCommand: true, SetupAgentWithdrawCommand: true,
}

var setupBoardWindowCommands = map[string]bool{
	SetupBoardOpenCommand: true, SetupBoardCloseCommand: true, SetupBoardStateCommand: true,
	SetupBoardDecideCommand: true, SetupBoardApplyCommand: true, SetupBoardCopyCommand: true,
}

// SetupAgentRequest is what `molten pipeline setup` sends; the project comes from the terminal's tab, never from it.
type SetupAgentRequest struct {
	// propose: one change in #1099's contract.
	Change json.RawMessage `json:"change,omitempty"`
	Why    string          `json:"why,omitempty"`
	// propose: the step as the panel should read it once changed, and who does it.
	Say string `json:"say,omitempty"`
	Who string `json:"who,omitempty"`
	// flag and explain: "rc/3" or "rc/<step id>".
	Step   string `json:"step,omitempty"`
	Point  string `json:"point,omitempty"`
	Answer string `json:"answer,omitempty"`
	Note   string `json:"note,omitempty"`
	// withdraw: the proposal's key.
	Key string `json:"key,omitempty"`
}

// SetupAgentAnswer is the board as the agent reads it, and the item its command added.
type SetupAgentAnswer struct {
	State pipelinesetup.BoardState `json:"state"`
	Item  *pipelinesetup.BoardItem `json:"item,omitempty"`
}

type SetupBoardDirRequest struct {
	Dir string `json:"dir"`
}

type SetupBoardDecideRequest struct {
	Dir    string `json:"dir"`
	Key    string `json:"key"`
	Accept bool   `json:"accept"`
}

type SetupBoardApplyRequest struct {
	Dir  string `json:"dir"`
	Text string `json:"text"`
}

// SetupBoardScope resolves a terminal's block to the project its pipeline tab sets up, and the first name of the
// agent running in it.
type SetupBoardScope func(ctx context.Context, blockId string) (dir string, by string, err error)

func liveSetupBoardScope(ctx context.Context, blockId string) (string, string, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return "", "", fmt.Errorf("this terminal is unknown to MoltenTerm")
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil || tabId == "" {
		return "", "", fmt.Errorf("this terminal is in no tab")
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil {
		return "", "", fmt.Errorf("this terminal's tab is unknown to MoltenTerm")
	}
	return tab.Meta.GetString(PipelineTabMetaKey, ""), block.Meta.GetString(molten.AgentFirstNameMetaKey, ""), nil
}

// SetupBoardRoute answers the board's commands.
type SetupBoardRoute struct {
	Board *pipelinesetup.Board
	Scope SetupBoardScope
}

func MakeSetupBoardRoute() *SetupBoardRoute {
	board := pipelinesetup.MakeBoard(func(state pipelinesetup.BoardState) {
		wps.Broker.Publish(wps.WaveEvent{Event: SetupBoardEvent, Scopes: []string{state.Dir}, Data: state})
	})
	return &SetupBoardRoute{Board: board, Scope: liveSetupBoardScope}
}

// IsSetupBoardCommand: the commands Handle answers.
func IsSetupBoardCommand(command string) bool {
	return setupAgentCommands[command] || setupBoardWindowCommands[command]
}

// addSetupBoardPolicy lets the agent's commands in from local terminals only and the panel's from windows only.
func addSetupBoardPolicy(policy localroute.Policy) {
	for command := range setupAgentCommands {
		policy.Commands[command] = localroute.AllowLocalTerminal
		policy.Refusals[command] = "the pipeline setup's agent commands run in the terminal of the project's pipeline tab"
	}
	for command := range setupBoardWindowCommands {
		policy.Commands[command] = localroute.AllowWindow
		policy.Refusals[command] = "the pipeline setup's panel is answered to a MoltenTerm window"
	}
}

// Handle answers one command; the route's policy already checked the caller's kind.
func (r *SetupBoardRoute) Handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	if setupAgentCommands[command] {
		return r.handleAgent(ctx, command, caller, data)
	}
	if !caller.IsWindow {
		return nil, fmt.Errorf("the pipeline setup's panel is answered to a MoltenTerm window")
	}
	switch command {
	case SetupBoardOpenCommand:
		var req pipelinesetup.BoardContext
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return r.Board.Open(req)
	case SetupBoardDecideCommand:
		var req SetupBoardDecideRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return r.Board.Decide(req.Dir, req.Key, req.Accept)
	case SetupBoardApplyCommand:
		var req SetupBoardApplyRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return r.Board.Apply(req.Dir, req.Text)
	case SetupBoardCopyCommand:
		var req SetupBoardDecideRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return r.Board.CopyTo(req.Dir, req.Key)
	}
	var req SetupBoardDirRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if command == SetupBoardCloseCommand {
		return r.Board.Close(req.Dir)
	}
	return r.Board.State(req.Dir)
}

func (r *SetupBoardRoute) handleAgent(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	if !caller.IsLocalTerminal || caller.BlockId == "" {
		return nil, fmt.Errorf("the pipeline setup's agent commands run in the terminal of the project's pipeline tab")
	}
	scopeCtx, cancel := context.WithTimeout(ctx, setupBoardTimeout)
	defer cancel()
	dir, by, err := r.Scope(scopeCtx, caller.BlockId)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("this terminal is not in a pipeline setup tab: the pipeline setup commands run in the terminal beside the setup panel")
	}
	var req SetupAgentRequest
	if data != nil {
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
	}
	answer := SetupAgentAnswer{}
	switch command {
	case SetupAgentShowCommand:
		state, err := r.Board.State(dir)
		if err != nil {
			return nil, err
		}
		if !state.Open {
			return nil, &pipelinesetup.BoardRefusal{Code: "notopen", Detail: "the pipeline setup of this project is not open in MoltenTerm: ask the developer to open it (Release menu, pipeline setup)"}
		}
		answer.State = state
		return answer, nil
	case SetupAgentProposeCommand:
		item, err := r.Board.ProposeSaid(dir, by, req.Change, req.Why, req.Say, req.Who)
		if err != nil {
			return nil, err
		}
		answer.Item = &item
	case SetupAgentFlagCommand:
		item, err := r.Board.Flag(dir, by, req.Step, req.Point, req.Answer)
		if err != nil {
			return nil, err
		}
		answer.Item = &item
	case SetupAgentExplainCommand:
		if _, err := r.Board.Explain(dir, by, req.Step, req.Note); err != nil {
			return nil, err
		}
	case SetupAgentWithdrawCommand:
		if _, err := r.Board.Withdraw(dir, req.Key); err != nil {
			return nil, err
		}
	}
	state, err := r.Board.State(dir)
	if err != nil {
		return nil, err
	}
	answer.State = state
	return answer, nil
}
