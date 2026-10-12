// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The coffee approvals (FR-SHELL-063, DS-SHELL-110): Claude Code's PermissionRequest hook runs `molten agent
// permission`, added by the launcher. It hands the request to wavesrv, which approves it while the pane's workspace
// has its coffee on and the deny list lets it through. It prints the allow decision only then: any other answer, an
// error or a timeout prints nothing and exits 0, and the agent shows its own prompt (NFR-SHELL-033).

const (
	moltenAgentPermissionTimeoutMs = 5000
	moltenAgentPermissionMaxStdin  = 256 * 1024
)

var moltenAgentPermissionAgent string

var moltenAgentPermissionCmd = &cobra.Command{
	Use:   "permission",
	Short: "answer the coding agent's permission request while its workspace's coffee is on (for the agent's hooks)",
	Long: "Answer the permission request of the coding agent running in this terminal, from its PermissionRequest " +
		"hook: while the workspace's coffee is on, MoltenTerm approves what its deny list lets through; otherwise " +
		"nothing is printed and the agent asks you as usual. Reads the hook's JSON input on stdin. MoltenTerm's " +
		"launcher adds this hook to the Claude Code and Codex sessions it starts (Codex runs it once you trust it in /hooks).",
	Args: cobra.NoArgs,
	RunE: moltenAgentPermissionRun,
}

func init() {
	moltenAgentPermissionCmd.Flags().StringVar(&moltenAgentPermissionAgent, "agent", "", "the agent: claude or codex")
	moltenAgentCmd.AddCommand(moltenAgentPermissionCmd)
}

// permissionHookInput is what Claude Code's (and Codex's) PermissionRequest hook gets on stdin.
type permissionHookInput struct {
	SessionId      string         `json:"session_id"`
	Cwd            string         `json:"cwd"`
	PermissionMode string         `json:"permission_mode"`
	ToolName       string         `json:"tool_name"`
	ToolInput      map[string]any `json:"tool_input"`
}

type permissionHookDecision struct {
	Behavior string `json:"behavior"`
}

type permissionHookSpecific struct {
	HookEventName string                 `json:"hookEventName"`
	Decision      permissionHookDecision `json:"decision"`
}

type permissionHookOutput struct {
	HookSpecificOutput permissionHookSpecific `json:"hookSpecificOutput"`
}

// readPermissionRequest turns the hook's input into the request wavesrv answers; ok is false when it is not one.
func readPermissionRequest(r io.Reader, blockId string, agent string) (keepawake.PermissionRequest, bool) {
	data, err := io.ReadAll(io.LimitReader(r, moltenAgentPermissionMaxStdin+1))
	if err != nil || len(data) > moltenAgentPermissionMaxStdin {
		return keepawake.PermissionRequest{}, false
	}
	var input permissionHookInput
	if json.Unmarshal(data, &input) != nil || input.ToolName == "" || blockId == "" {
		return keepawake.PermissionRequest{}, false
	}
	return keepawake.PermissionRequest{
		BlockId: blockId, Agent: agent, SessionId: input.SessionId, Cwd: input.Cwd, PermissionMode: input.PermissionMode,
		ToolName: input.ToolName, ToolInput: input.ToolInput,
	}, true
}

// runAgentPermission prints the hook's allow decision when wavesrv approves, nothing otherwise.
func runAgentPermission(r io.Reader, w io.Writer, blockId string, agent string, send func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error)) {
	req, ok := readPermissionRequest(r, blockId, agent)
	if !ok {
		return
	}
	answer, err := send(req)
	if err != nil || answer.Decision != keepawake.PermissionAllow {
		return
	}
	out, err := json.Marshal(permissionHookOutput{HookSpecificOutput: permissionHookSpecific{
		HookEventName: molten.ClaudePermissionHookEvent, Decision: permissionHookDecision{Behavior: keepawake.PermissionAllow},
	}})
	if err != nil {
		return
	}
	fmt.Fprintf(w, "%s\n", out)
}

func sendPermissionRequest(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
	var answer keepawake.PermissionAnswer
	jwtToken := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwtToken == "" {
		return answer, fmt.Errorf("not in a MoltenTerm terminal")
	}
	if err := setupHookRpcClient(jwtToken); err != nil {
		return answer, err
	}
	opts := &wshrpc.RpcOpts{Route: keepawake.Route, Timeout: moltenAgentPermissionTimeoutMs}
	out, err := RpcClient.SendRpcRequest(keepawake.PermissionCommand, req, opts)
	if err != nil {
		return answer, err
	}
	err = utilfn.ReUnmarshal(&answer, out)
	return answer, err
}

// Never an error or an exit code: a failing hook must leave the agent's prompt as it is.
func moltenAgentPermissionRun(cmd *cobra.Command, args []string) error {
	if moltenAgentPermissionAgent != "" && !molten.ValidAgentId(moltenAgentPermissionAgent) {
		return nil
	}
	blockId := os.Getenv("WAVETERM_BLOCKID")
	if claims, err := agenthook.ParseTokenClaims(os.Getenv(wshutil.WaveJwtTokenVarName)); err == nil && claims.BlockId != "" {
		blockId = claims.BlockId
	}
	runAgentPermission(os.Stdin, os.Stdout, blockId, moltenAgentPermissionAgent, sendPermissionRequest)
	return nil
}
