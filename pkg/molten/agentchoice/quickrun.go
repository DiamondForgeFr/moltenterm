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
// into words (#2392): it has nothing to look up, so a sentence in that text that asks it to read a file finds no tool.
var ClaudeNoReadTools = []string{"Read", "Glob", "Grep", "LS", "Task", "NotebookRead", "TodoWrite"}

// TextOnlyPrintArgv is QuickPrintArgv for an answer made from the prompt alone: Claude Code also loses its reading
// tools (they come last, as --disallowed-tools takes every argument after it). nil for an agent without a quick form.
func TextOnlyPrintArgv(id string, dirs ...string) []string {
	argv := QuickPrintArgv(id, dirs...)
	if argv == nil {
		return nil
	}
	if id == molten.AgentIdClaude {
		argv = append(argv, ClaudeNoReadTools...)
	}
	return argv
}

// RunPrintArgv runs a non-interactive agent form in dir with the login shell's PATH, since a window opened from the
// desktop has a bare one, the prompt on its standard input. Nothing shows on a terminal; stderr is kept for the error.
func RunPrintArgv(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("no agent command")
	}
	path := molten.LoginPath()
	program := molten.LookPathIn(argv[0], path)
	if program == "" {
		return nil, fmt.Errorf("%s is not on the login PATH", argv[0])
	}
	cmd := spawns.Command(ctx, program, argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+path)
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
