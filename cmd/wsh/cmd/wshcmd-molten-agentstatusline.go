// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

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

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Claude Code's status line relay (FR-SHELL-027, DS-SHELL-031). Claude Code runs it as its statusLine command:
// it runs the user's own status line command with the same input and environment, so what Claude Code shows does not
// change, and in a MoltenTerm terminal it also hands the input's rate limit windows, and nothing else, to the pane's
// companion. Outside MoltenTerm it only runs the command. It never prints anything of its own: any failure of the
// hand-off is ignored, the status line is the user's.

// The whole hand-off, connection included, never holds the status line longer than this.
const moltenStatusLineSendTimeout = 300 * time.Millisecond

var moltenAgentStatusLineCmd = &cobra.Command{
	Use:   "statusline [-- <command> [args...]]",
	Short: "Claude Code's statusLine relay: runs your status line command unchanged and shows the plan limits in the companion",
	Long: "Meant as Claude Code's statusLine command, wrapping your own: it runs <command> (one argument runs through " +
		"sh -c) with the same input and environment and passes its output and exit code through unchanged. In a " +
		"MoltenTerm terminal it also hands the input's rate_limits (5-hour and 7-day windows) to the agent companion's " +
		"plan usage. Without a command it prints nothing. The companion shows the setting to paste when you turn on " +
		"Show plan usage; MoltenTerm never edits Claude Code's settings.",
	DisableFlagParsing: true,
	RunE:               moltenAgentStatusLineRun,
}

func init() {
	moltenAgentCmd.AddCommand(moltenAgentStatusLineCmd)
}

func moltenAgentStatusLineRun(cmd *cobra.Command, args []string) error {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		return cmd.Help()
	}
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	WshExitCode = runStatusLineRelay(os.Stdin, os.Stdout, os.Stderr, args, moltenStatusLineSender())
	return nil
}

type statusLineSender func(req molten.AgentStatusLineRequest)

// moltenStatusLineSender sends to the companion of the terminal the relay runs in, or is nil outside MoltenTerm.
func moltenStatusLineSender() statusLineSender {
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	blockId := os.Getenv("WAVETERM_BLOCKID")
	if jwt == "" || blockId == "" {
		return nil
	}
	return func(req molten.AgentStatusLineRequest) {
		if setupRpcClient(nil, jwt) != nil {
			return
		}
		req.BlockId = blockId
		if RpcContext.BlockId != "" {
			req.BlockId = RpcContext.BlockId
		}
		opts := &wshrpc.RpcOpts{Route: molten.CompanionRoute, Timeout: int64(moltenStatusLineSendTimeout / time.Millisecond)}
		RpcClient.SendRpcRequest(molten.AgentStatusLineCommand, req, opts)
	}
}

// runStatusLineRelay runs the chained command on the relay's whole input while the windows are handed off, and
// returns the command's exit code.
func runStatusLineRelay(stdin io.Reader, stdout io.Writer, stderr io.Writer, args []string, send statusLineSender) int {
	start := time.Now()
	head, _ := io.ReadAll(io.LimitReader(stdin, molten.StatusLineMaxInput+1))
	var sent chan struct{}
	if send != nil && len(head) <= molten.StatusLineMaxInput {
		req, err := molten.ParseStatusLineInput(head)
		if err != nil {
			// An input this relay cannot read is reported as unreadable limits: the companion says the source changed.
			req = molten.AgentStatusLineRequest{RateLimits: true}
		}
		sent = make(chan struct{})
		go func() {
			defer close(sent)
			defer func() {
				panichandler.PanicHandlerNoTelemetry("molten:statusline:send", recover())
			}()
			send(req)
		}()
	}
	code := 0
	if len(args) > 0 {
		code = runStatusLineCommand(args, io.MultiReader(bytes.NewReader(head), stdin), stdout, stderr)
	}
	if sent != nil {
		wait := moltenStatusLineSendTimeout - time.Since(start)
		if wait > 0 {
			select {
			case <-sent:
			case <-time.After(wait):
			}
		}
	}
	return code
}

// statusLineCommand: one argument is a shell command line, as Claude Code's statusLine command is; several are a
// program and its arguments.
func statusLineCommand(args []string) *exec.Cmd {
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

func runStatusLineCommand(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	c := statusLineCommand(args)
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
