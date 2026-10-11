// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// must match pkg/wshutil.WaveJwtTokenVarName
const jwtVarName = "WAVETERM_JWT"

const (
	stateTimeout  = 5 * time.Second
	maxStateStdin = 64 * 1024
)

// Env is what a hook run reads and writes.
type Env struct {
	Getenv func(string) string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// CacheDir: where the status line relay remembers its hand-offs (StatusLineCacheDir), "" for none.
	CacheDir string
}

// StateArgs are the arguments of `molten agent state` (cmd/wsh/cmd/wshcmd-molten-agentstate.go).
type StateArgs struct {
	State   string
	Agent   string
	Message string
	Stdin   bool
}

// RunFast runs `molten agent state` and `molten agent statusline` (args: what follows `molten`). handled is false for
// anything else, and for any form of these two the small program does not read exactly as wsh does (help, an unknown
// flag, a mistake to report): wsh runs those.
func RunFast(args []string, env Env) (handled bool, code int) {
	if len(args) < 2 || args[0] != "agent" {
		return false, 0
	}
	switch args[1] {
	case "state":
		sa, ok := ParseStateArgs(args[2:])
		if !ok {
			return false, 0
		}
		return runState(sa, env)
	case "statusline":
		rest := args[2:]
		if len(rest) > 0 && (rest[0] == "-h" || rest[0] == "--help") {
			return false, 0
		}
		if len(rest) > 0 && rest[0] == "--" {
			rest = rest[1:]
		}
		return true, RunStatusLineRelay(env.Stdin, env.Stdout, env.Stderr, rest, MakeStatusLineSender(env.Getenv, env.CacheDir))
	}
	return false, 0
}

// ParseStateArgs reads `<state> [payload] [--agent a] [--message m] [--stdin]` as cobra does, flags anywhere; ok is
// false for anything else or for values wsh reports as mistakes.
func ParseStateArgs(args []string) (StateArgs, bool) {
	var sa StateArgs
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "" || arg[0] != '-' || arg == "-" {
			positional = append(positional, arg)
			continue
		}
		name, value, hasValue := strings.Cut(arg, "=")
		switch name {
		case "--agent", "--message":
			if !hasValue {
				if i+1 >= len(args) {
					return sa, false
				}
				i++
				value = args[i]
			}
			if name == "--agent" {
				sa.Agent = value
			} else {
				sa.Message = value
			}
		case "--stdin":
			switch {
			case !hasValue || value == "true":
				sa.Stdin = true
			case value == "false":
				sa.Stdin = false
			default:
				return sa, false
			}
		default:
			return sa, false
		}
	}
	if len(positional) < 1 || len(positional) > 2 {
		return sa, false
	}
	sa.State = positional[0]
	if !ValidAgentState(sa.State) || (sa.Agent != "" && !ValidAgentId(sa.Agent)) {
		return sa, false
	}
	return sa, true
}

// HookMessage reads the "message" field of a hook's JSON input (Claude Code's Notification hook).
func HookMessage(r io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(r, maxStateStdin))
	if err != nil {
		return ""
	}
	var input struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &input) != nil {
		return ""
	}
	return input.Message
}

func runState(sa StateArgs, env Env) (bool, int) {
	token := env.Getenv(jwtVarName)
	if token == "" {
		return false, 0
	}
	blockId := env.Getenv("WAVETERM_BLOCKID")
	if claims, err := ParseTokenClaims(token); err == nil && claims.BlockId != "" {
		blockId = claims.BlockId
	}
	if blockId == "" {
		return false, 0
	}
	message := sa.Message
	if sa.Stdin && message == "" {
		message = HookMessage(env.Stdin)
	}
	req := AgentStateRequest{BlockId: blockId, State: sa.State, Agent: sa.Agent, Message: message}
	if err := SendAgentState(token, req); err != nil {
		fmt.Fprintf(env.Stderr, "molten: %v\n", err)
		return true, 1
	}
	return true, 0
}

// SendAgentState reports a state on its own connection.
func SendAgentState(token string, req AgentStateRequest) error {
	deadline := time.Now().Add(stateTimeout)
	c, err := Dial(token, deadline)
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.Call(AgentStateSetCommand, AgentStatesRoute, req, deadline)
	return err
}

// MakeStatusLineSender hands the windows to the companion of the terminal the relay runs in, at most once for the same
// windows (statuslinecache.go); nil outside MoltenTerm.
func MakeStatusLineSender(getenv func(string) string, cacheDir string) StatusLineSender {
	token := getenv(jwtVarName)
	blockId := getenv("WAVETERM_BLOCKID")
	if token == "" || blockId == "" {
		return nil
	}
	return func(req AgentStatusLineRequest) {
		req.BlockId = blockId
		if claims, err := ParseTokenClaims(token); err == nil && claims.BlockId != "" {
			req.BlockId = claims.BlockId
		}
		if !StatusLineSendDue(cacheDir, req, time.Now()) {
			return
		}
		deadline := time.Now().Add(StatusLineSendTimeout)
		c, err := Dial(token, deadline)
		if err != nil {
			return
		}
		defer c.Close()
		data, err := c.Call(AgentStatusLineCommand, CompanionRoute, req, deadline)
		if err != nil {
			return
		}
		RecordStatusLineSent(cacheDir, req, StatusLineKept(data), time.Now())
	}
}
