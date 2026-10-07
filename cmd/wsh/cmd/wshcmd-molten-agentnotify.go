// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Codex's notify wrapper (FR-SHELL-038, DS-SHELL-050). The codex launcher sets, for one run,
// notify = [<molten>, "agent", "notify", "--agent", "codex", "--", <the user's own notify argv>]. Codex runs it at
// each turn's end with a JSON payload appended as the last argument ({type: agent-turn-complete, thread-id, turn-id,
// cwd, input-messages, last-assistant-message}). The user's own notify starts first, with exactly the argument Codex
// gives it, so it is never delayed; then the pane gets the session link and the done state (the thread id, nothing of
// the prompts or answers). Whatever fails on MoltenTerm's side, the user's program runs, and its exit code is ours.

// The pane's reports never hold the wrapper longer than this; Codex does not wait for notify anyway.
const moltenAgentNotifyReportTimeout = 2 * time.Second

const moltenAgentNotifyTurnComplete = "agent-turn-complete"

var moltenAgentNotifyCmd = &cobra.Command{
	Use:   "notify --agent codex [--session-only] -- [your notify program and its arguments] <payload>",
	Short: "report a coding agent's turn end, then run your own notify program (what the codex launcher sets as notify)",
	Long: "Codex's notify for runs started through MoltenTerm's codex launcher: it runs your own notify program, if " +
		"any, with the same JSON payload as its last argument, then tells this terminal's pane which session the turn " +
		"belongs to (the thread id only) and that the turn is done (not with --session-only, when your own notify " +
		"reports it). Outside a MoltenTerm terminal it only runs your program.",
	DisableFlagParsing: true,
	RunE:               moltenAgentNotifyRun,
}

func init() {
	moltenAgentCmd.AddCommand(moltenAgentNotifyCmd)
}

type moltenNotifyArgs struct {
	agent       string
	sessionOnly bool
	program     []string
	payload     string
}

// parseMoltenAgentNotifyArgs splits `--agent <id> [--session-only] -- [argv...] <payload>`.
func parseMoltenAgentNotifyArgs(args []string) (moltenNotifyArgs, error) {
	var rtn moltenNotifyArgs
	usage := fmt.Errorf("usage: molten agent notify --agent <agent> [--session-only] -- [program args...] <payload>")
	if len(args) < 3 || args[0] != "--agent" {
		return rtn, usage
	}
	rtn.agent = args[1]
	rest := args[2:]
	if rest[0] == agentlaunch.NotifySessionOnlyFlag {
		rtn.sessionOnly, rest = true, rest[1:]
	}
	if len(rest) == 0 || rest[0] != "--" {
		return rtn, usage
	}
	if !molten.ValidAgentId(rtn.agent) {
		return rtn, fmt.Errorf("invalid agent name %q", rtn.agent)
	}
	rest = rest[1:]
	if len(rest) == 0 {
		return rtn, nil
	}
	rtn.program, rtn.payload = rest[:len(rest)-1], rest[len(rest)-1]
	return rtn, nil
}

func moltenAgentNotifyRun(cmd *cobra.Command, args []string) error {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		return cmd.Help()
	}
	parsed, err := parseMoltenAgentNotifyArgs(args)
	if err != nil {
		WriteStderr("%v\n", err)
		WshExitCode = 2
		return nil
	}
	WshExitCode = runMoltenAgentNotify(parsed, os.Getenv)
	return nil
}

func runMoltenAgentNotify(args moltenNotifyArgs, getenv func(string) string) int {
	var child *exec.Cmd
	if len(args.program) > 0 {
		child = moltenNotifyCommand(args.program, args.payload)
		if err := child.Start(); err != nil {
			WriteStderr("molten agent notify: %s: %v\n", args.program[0], err)
			child = nil
		}
	}
	reportMoltenAgentNotify(args, getenv)
	if child == nil {
		if len(args.program) > 0 {
			return 127
		}
		return 0
	}
	if err := child.Wait(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

// moltenNotifyCommand runs the user's notify as Codex does: the program looked up on PATH, its arguments, then the
// payload, with the environment, folder and standard streams Codex gave the wrapper.
func moltenNotifyCommand(program []string, payload string) *exec.Cmd {
	argv := append(append([]string{}, program[1:]...), payload)
	child := exec.Command(program[0], argv...)
	// Codex finds the program through PATH even in a "." entry; so does the wrapper.
	if errors.Is(child.Err, exec.ErrDot) {
		child.Err = nil
	}
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	return child
}

// moltenNotifyPayload is what the wrapper reads of Codex's payload: the event and the thread id, nothing else.
type moltenNotifyPayload struct {
	Type     string `json:"type"`
	ThreadId string `json:"thread-id"`
}

// reportMoltenAgentNotify links the turn's session, then tells the pane that the agent's turn ended, within the time
// cap. A sub-agent's turn (its thread is not the pane's session) reports nothing: the pane's agent is still at work.
// The link gets at most half of the cap, so the done state always has time.
func reportMoltenAgentNotify(args moltenNotifyArgs, getenv func(string) string) {
	var event moltenNotifyPayload
	if json.Unmarshal([]byte(args.payload), &event) != nil || event.Type != moltenAgentNotifyTurnComplete {
		return
	}
	jwt := getenv(wshutil.WaveJwtTokenVarName)
	if getenv("WAVETERM_BLOCKID") == "" || jwt == "" {
		return
	}
	deadline := time.Now().Add(moltenAgentNotifyReportTimeout)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if setupRpcClient(nil, jwt) != nil {
			return
		}
		blockId := RpcContext.BlockId
		if blockId == "" {
			blockId = getenv("WAVETERM_BLOCKID")
		}
		if strings.TrimSpace(event.ThreadId) != "" {
			session := molten.AgentSessionRequest{BlockId: blockId, Agent: args.agent, SessionId: event.ThreadId}
			linkMs := max(int64(time.Until(deadline)/time.Millisecond)/2, 1)
			_, err := RpcClient.SendRpcRequest(molten.CompanionSessionCommand, session, &wshrpc.RpcOpts{Route: molten.CompanionRoute, Timeout: linkMs})
			if err != nil && strings.Contains(err.Error(), molten.SubagentSessionError) {
				return
			}
		}
		if args.sessionOnly {
			return
		}
		left := max(int64(time.Until(deadline)/time.Millisecond), 1)
		state := molten.AgentStateRequest{BlockId: blockId, State: molten.AgentStateDone, Agent: args.agent, TurnEnd: true}
		RpcClient.SendRpcRequest(molten.AgentStateSetCommand, state, &wshrpc.RpcOpts{Route: molten.AgentStatesRoute, Timeout: left})
	}()
	select {
	case <-done:
	case <-time.After(time.Until(deadline)):
	}
}
