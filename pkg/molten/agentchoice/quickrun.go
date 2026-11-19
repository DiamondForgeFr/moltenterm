// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentchoice

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
)

// maxQuickOutput bounds what a quick run may print: a short answer is a few lines.
const maxQuickOutput = 64 << 10

// ClaudeNoReadTools are denied on top of ClaudeReadOnlyDeniedTools when a quick run only turns the text it was given
// into words (#2392). They come after --tools "" as a second lock, for a Claude Code that would not know that flag.
var ClaudeNoReadTools = []string{"Read", "Glob", "Grep", "LS", "Task", "Agent", "Skill", "ToolSearch", "NotebookRead", "TodoWrite"}

// TextOnlyPrintArgv is the form of an agent that answers from its prompt alone, with no tool at all (#2392): the prompt
// holds text anyone can write (a ticket's title and body). Claude Code takes `--tools ""`, its documented "no built-in
// tool" (claude --help, 2.1.x), on top of the quick read-only form and a deny list of every reading tool. Codex has no
// documented switch that takes its shell and every file-reading tool away (its read-only sandbox still reads anywhere),
// so it has no such form, like the agents without a quick one: nil.
func TextOnlyPrintArgv(id string, dirs ...string) []string {
	if id != molten.AgentIdClaude {
		return nil
	}
	argv := QuickPrintArgv(id, dirs...)
	if argv == nil {
		return nil
	}
	rtn := append(append([]string{}, argv[:2]...), "--tools", "")
	rtn = append(rtn, argv[2:]...)
	return append(rtn, ClaudeNoReadTools...)
}

// textOnlyEnvKeys are what a text-only run inherits of wavesrv's environment, by agent: what finds the program and the
// user's account (the system keychain needs HOME and USER), the locale, and the provider's own sign-in. Nothing else,
// so none of wavesrv's tokens or a project's variables reach the agent.
var textOnlyEnvKeys = map[string][]string{
	"": {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"},
	molten.AgentIdClaude: {
		"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR",
		"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_PROFILE", "AWS_REGION",
		"CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID",
	},
}

// TextOnlyEnv is the environment of a text-only run of agent: the kept keys of environ (KEY=value entries) and PATH.
func TextOnlyEnv(agent string, environ []string, path string) []string {
	keep := map[string]bool{}
	for _, key := range textOnlyEnvKeys[""] {
		keep[key] = true
	}
	for _, key := range textOnlyEnvKeys[agent] {
		keep[key] = true
	}
	rtn := []string{"PATH=" + path}
	for _, entry := range environ {
		key, _, ok := strings.Cut(entry, "=")
		if ok && keep[key] {
			rtn = append(rtn, entry)
		}
	}
	return rtn
}

// RunTextOnly runs the agent's text-only form in dir, the prompt on its standard input, with the login shell's PATH
// (a window opened from the desktop has a bare one) and the environment TextOnlyEnv keeps. Nothing shows on a terminal;
// stderr is kept for the error.
func RunTextOnly(ctx context.Context, dir string, agent string, prompt string) ([]byte, error) {
	argv := TextOnlyPrintArgv(agent, dir)
	if argv == nil {
		return nil, fmt.Errorf("%s has no text-only form", agent)
	}
	path := molten.LoginPath()
	program := molten.LookPathIn(argv[0], path)
	if program == "" {
		return nil, fmt.Errorf("%s is not on the login PATH", argv[0])
	}
	cmd := spawns.Command(ctx, program, argv[1:]...)
	cmd.Dir = dir
	cmd.Env = TextOnlyEnv(agent, os.Environ(), path)
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if lines := strings.Split(msg, "\n"); msg != "" {
			msg = strings.TrimSpace(lines[len(lines)-1])
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s: %s", argv[0], msg)
	}
	if stdout.Len() > maxQuickOutput {
		return nil, fmt.Errorf("%s printed more than a short answer", argv[0])
	}
	return stdout.Bytes(), nil
}
