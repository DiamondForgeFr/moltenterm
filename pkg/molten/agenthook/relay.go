// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

// Claude Code's status line relay (FR-SHELL-027, DS-SHELL-031). Claude Code runs it as its statusLine command:
// it runs the user's own status line command with the same input and environment, so what Claude Code shows does not
// change, and in a MoltenTerm terminal it also hands the input's rate limit windows, model and effort level (#549), and
// nothing else, to the pane's companion and header. Outside MoltenTerm it only runs the command. It never prints anything of its own: any failure of the
// hand-off is ignored, the status line is the user's.

// The whole hand-off, connection included, never holds the status line longer than this.
const StatusLineSendTimeout = 300 * time.Millisecond

// relaySendTimeout is StatusLineSendTimeout; a test lifts it out of reach to tell a hand-off run alongside the command
// from one run before it without timing either (#1208).
var relaySendTimeout = StatusLineSendTimeout

// StatusLineSender hands the windows over; nil outside MoltenTerm.
type StatusLineSender func(req AgentStatusLineRequest)

// RunStatusLineRelay runs the chained command on the relay's whole input while the windows are handed off, and
// returns the command's exit code.
func RunStatusLineRelay(stdin io.Reader, stdout io.Writer, stderr io.Writer, args []string, send StatusLineSender) int {
	start := time.Now()
	head, _ := io.ReadAll(io.LimitReader(stdin, StatusLineMaxInput+1))
	var sent chan struct{}
	if send != nil && len(head) <= StatusLineMaxInput {
		req, err := ParseStatusLineInput(head)
		if err != nil {
			// An input this relay cannot read is reported as unreadable limits: the companion says the source changed.
			req = AgentStatusLineRequest{RateLimits: true}
		}
		sent = make(chan struct{})
		go func() {
			defer close(sent)
			// The hand-off never takes the status line down with it.
			defer func() { recover() }()
			send(req)
		}()
	}
	code := 0
	if len(args) > 0 {
		code = RunStatusLineCommand(args, io.MultiReader(bytes.NewReader(head), stdin), stdout, stderr)
	}
	if sent != nil {
		wait := relaySendTimeout - time.Since(start)
		if wait > 0 {
			select {
			case <-sent:
			case <-time.After(wait):
			}
		}
	}
	return code
}

// StatusLineCommand: one argument is a shell command line, as Claude Code's statusLine command is; several are a
// program and its arguments.
func StatusLineCommand(args []string) *exec.Cmd {
	if len(args) > 1 {
		return exec.Command(args[0], args[1:]...)
	}
	if runtime.GOOS == "windows" {
		if sh, err := exec.LookPath("sh"); err == nil {
			return exec.Command(sh, "-c", args[0])
		}
		return exec.Command("cmd", "/C", args[0])
	}
	return exec.Command("/bin/sh", "-c", args[0])
}

// RunStatusLineCommand runs the chained command and returns its exit code (128 + the signal when one stopped it).
func RunStatusLineCommand(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	c := StatusLineCommand(args)
	c.Stdin, c.Stdout, c.Stderr = stdin, stdout, stderr
	if err := c.Start(); err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", args[0], err)
		return 127
	}
	// Claude Code cancels a status line run still going when a new one starts: the command stops with the relay.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	defer close(done)
	defer signal.Stop(signals)
	go func() {
		select {
		case sig := <-signals:
			c.Process.Signal(sig)
		case <-done:
		}
	}()
	err := c.Wait()
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return 1
	}
	if code := ee.ExitCode(); code >= 0 {
		return code
	}
	if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return 1
}
