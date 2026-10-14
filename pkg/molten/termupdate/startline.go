// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// A new terminal that runs a command of MoltenTerm's in its shell (the review session's agent, FR-REV-004): the shell
// starts, its line editor starts after its first prompt, then the line is typed with Enter, so the command runs as if
// the developer had typed it, with their PATH (the agent launchers first) and startup files. Without a prompt in time,
// something else reads the terminal (a question of the startup files, a passphrase): nothing is typed.

var errNoPrompt = errors.New("the terminal showed no prompt")

// StartAndType starts a terminal with start, waits for its shell's first prompt, then types line and Enter.
func StartAndType(ctx context.Context, blockId string, start func(context.Context) error, line string) error {
	u := getRunningUpdater()
	if u == nil {
		return errors.New("MoltenTerm cannot type in terminals yet")
	}
	return u.StartAndType(ctx, blockId, start, line)
}

func (u *Updater) StartAndType(ctx context.Context, blockId string, start func(context.Context) error, line string) error {
	line = cleanTypedLine(line)
	if line == "" {
		return errors.New("there is no command to type")
	}
	prompts, release := u.env.WatchPrompt(blockId)
	defer release()
	if err := start(ctx); err != nil {
		return fmt.Errorf("the terminal did not start: %w", err)
	}
	select {
	case <-prompts:
		u.env.Sleep(lineEditorSettle)
	case <-time.After(firstPromptTimeout):
		return errNoPrompt
	case <-ctx.Done():
		return errNoPrompt
	}
	return u.env.SendInput(blockId, []byte(line+"\r"))
}
