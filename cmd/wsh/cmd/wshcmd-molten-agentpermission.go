// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
// has its coffee on or the agent session was set to approve its own requests, and the deny list lets it through; and
// which holds it, within the hook's budget, while a window shows the companion of the pane (#2474), where the developer
// allows or denies it. It prints the allow or deny decision only then: any other answer, an error or a timeout prints
// nothing and exits 0, and the agent shows its own prompt (NFR-SHELL-033).

const (
	moltenAgentPermissionTimeoutMs = 5000
	moltenAgentPermissionMaxStdin  = 256 * 1024
	// The hold leaves this much of the hook's budget for the reply and the print; the call waits that much longer
	// than the hold for wavesrv's answer.
	moltenAgentPermissionMarginMs = 3000
	moltenAgentPermissionReplyMs  = 1500
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
	// The rules the agent offers for "always allow" (Claude Code), kept as it sent them.
	PermissionSuggestions []any `json:"permission_suggestions"`
}

type permissionHookDecision struct {
	Behavior           string `json:"behavior"`
	UpdatedPermissions []any  `json:"updatedPermissions,omitempty"`
	Message            string `json:"message,omitempty"`
	// UpdatedInput: the tool's input with the developer's answers to a question of Brokk's agent (#2382).
	UpdatedInput map[string]any `json:"updatedInput,omitempty"`
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
		ToolName: input.ToolName, ToolInput: input.ToolInput, Suggestions: input.PermissionSuggestions,
		HoldMs: permissionHoldMs(agent, os.Getenv(molten.OwnSessionEnvVar) == "1"), Pid: int32(os.Getpid()),
	}, true
}

// permissionHoldMs is how long wavesrv may keep the request for the developer's answer: the hook's budget less a
// margin, so the hook always prints before the agent kills it. Brokk's own session asks in his layer (#2257) and has the
// long budget; any other terminal's request is held only for the companion (#2474), which wavesrv decides: it does so
// while a window shows that terminal's companion and the run's launcher gave the hook its budget, and answers at once
// otherwise. A hook that names no agent, or one MoltenTerm does not answer, is never held.
func permissionHoldMs(agent string, ownSession bool) int64 {
	budget := int64(0)
	switch {
	case agent == molten.AgentIdClaude && ownSession:
		budget = int64(molten.ClaudeOwnSessionPermissionHookTimeout)
	case agent == molten.AgentIdClaude:
		budget = int64(molten.ClaudePermissionHookTimeout)
	case agent == molten.AgentIdCodex:
		budget = int64(molten.CodexPermissionHookTimeout)
	}
	return max(budget*1000-moltenAgentPermissionMarginMs, 0)
}

// reportPermissionWaiting tells the pane its agent now waits on its own prompt (#988): Codex has no Notification
// event, so a request the hook leaves to the developer is its waiting signal; Claude Code's Notification says the
// same. A test replaces it.
var reportPermissionWaiting = func(blockId string, agent string) {
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	if token == "" {
		return
	}
	agenthook.SendAgentState(token, agenthook.AgentStateRequest{BlockId: blockId, State: molten.AgentStateWaiting, Agent: agent})
}

// runAgentPermission prints the hook's allow decision when wavesrv approves, nothing otherwise; the agent then asks
// the developer, and the pane shows it waiting.
func runAgentPermission(r io.Reader, w io.Writer, blockId string, agent string, send func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error)) {
	req, ok := readPermissionRequest(r, blockId, agent)
	if !ok {
		return
	}
	answer, err := send(req)
	if err != nil || (answer.Decision != keepawake.PermissionAllow && answer.Decision != keepawake.PermissionDeny) {
		reportPermissionWaiting(blockId, agent)
		return
	}
	decision := permissionHookDecision{Behavior: answer.Decision, UpdatedPermissions: answer.Updated, Message: answer.Message}
	if answer.Decision == keepawake.PermissionAllow {
		decision.UpdatedInput = answer.Input
	}
	out, err := json.Marshal(permissionHookOutput{HookSpecificOutput: permissionHookSpecific{
		HookEventName: molten.ClaudePermissionHookEvent, Decision: decision,
	}})
	if err != nil {
		return
	}
	fmt.Fprintf(w, "%s\n", out)
}

// permissionCall is one call to wavesrv's keep-awake route and the time it may take, in milliseconds.
type permissionCall func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error)

// exchangePermission asks wavesrv for the answer to a request. The first call takes the short time a hook always had,
// however long the hook is willing to wait: a request that is not held (the usual one) is answered within it, or the
// agent's own prompt takes it. Only when wavesrv says it holds the request for the companion does the hook wait, in a
// second call, for what wavesrv said at most and what its own budget leaves. Brokk's own session (#2257) asks in one call
// that waits for his answer.
func exchangePermission(call permissionCall, req keepawake.PermissionRequest, ownSession bool) (keepawake.PermissionAnswer, error) {
	timeout := int64(moltenAgentPermissionTimeoutMs)
	if ownSession && req.HoldMs > 0 {
		timeout = max(req.HoldMs+moltenAgentPermissionReplyMs, timeout)
	}
	answer, err := call(keepawake.PermissionCommand, req, timeout)
	if err != nil || answer.Wait == "" {
		return answer, err
	}
	wait := min(answer.WaitMs, req.HoldMs)
	if wait <= 0 {
		return keepawake.PermissionAnswer{}, nil
	}
	return call(keepawake.PermissionWaitCommand, keepawake.PermissionWait{BlockId: req.BlockId, Id: answer.Wait}, wait+moltenAgentPermissionReplyMs)
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
	call := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		var rtn keepawake.PermissionAnswer
		out, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: keepawake.Route, Timeout: timeoutMs})
		if err != nil {
			return rtn, err
		}
		err = utilfn.ReUnmarshal(&rtn, out)
		return rtn, err
	}
	return exchangePermission(call, req, os.Getenv(molten.OwnSessionEnvVar) == "1")
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
