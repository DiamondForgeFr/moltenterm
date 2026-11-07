// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build darwin || linux

package attention

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

const (
	// A generous bound for a failing run only: a loaded machine may start a shell slowly.
	shellTestDeadline = time.Minute
	shellPrompt       = "molten-prompt$ "
)

type ptyShell struct {
	file  pty.Pty
	cmd   *exec.Cmd
	out   chan []byte
	shell ShellProcess
	// printed: what the terminal showed so far, for the prompt.
	printed strings.Builder
}

// startPtyShell runs an interactive shell in a terminal of its own, without any rc file nor the shell integration, as
// a terminal pane runs it: at its prompt, the terminal's foreground group is the shell's.
func startPtyShell(t *testing.T, path string, args ...string) *ptyShell {
	t.Helper()
	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), fakeAgentEnv+"=1", "PS1="+shellPrompt, "ENV=", "BASH_ENV=")
	file, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	s := &ptyShell{file: file, cmd: cmd, out: make(chan []byte, 256)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := file.Read(buf)
			if n > 0 {
				select {
				case s.out <- append([]byte(nil), buf[:n]...):
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		killForeground(int32(cmd.Process.Pid))
		cmd.Process.Kill()
		cmd.Wait()
		file.Close()
		<-done
	})
	pid := int32(cmd.Process.Pid)
	table, err := proctree.Read()
	if err != nil {
		t.Fatal(err)
	}
	s.shell = ShellProcess{BlockId: "b1", Pid: pid, StartMs: table.Get(pid).StartMs}
	return s
}

// killForeground kills what the shell runs, the fake agent: it would otherwise wait out its 30 s.
func killForeground(shell int32) {
	table, err := proctree.Read()
	if err != nil {
		return
	}
	for _, p := range table.Foreground(shell) {
		if p.Pid == shell || !table.Under(p.Pid, shell) {
			continue
		}
		if proc, err := os.FindProcess(int(p.Pid)); err == nil {
			proc.Kill()
		}
	}
}

// forward hands the shell's output to the agent states, as the terminal's output does.
func (s *ptyShell) forward(h *procHarness) {
	for {
		select {
		case data := <-s.out:
			s.printed.Write(data)
			h.out("b1", string(data))
		default:
			return
		}
	}
}

// waitShell runs passes, the shell's output forwarded, until cond holds.
func waitShell(t *testing.T, h *procHarness, s *ptyShell, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(shellTestDeadline)
	for time.Now().Before(deadline) {
		s.forward(h)
		h.clock = time.Now()
		h.pw.pass()
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	run, ok := h.states.runOf("b1")
	t.Fatalf("%s never happened; last run %+v %v", what, run, ok)
}

// A fake Codex started at the prompt of /bin/sh, bash and zsh, none with the shell integration (#1476): it is found as
// a running agent in each, from the process tree alone, and forgotten once it exits.
func TestProcWatchFindsAgentInEveryShell(t *testing.T) {
	codex := filepath.Join(t.TempDir(), "bin", "codex")
	copyBinary(t, codex)
	for _, c := range []struct {
		name string
		path string
		args []string
	}{
		{"sh", "/bin/sh", []string{"-i"}},
		{"bash", "bash", []string{"--norc", "--noprofile", "-i"}},
		{"zsh", "zsh", []string{"-f", "-i"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			path, err := exec.LookPath(c.path)
			if err != nil {
				t.Skipf("%s is not installed", c.path)
			}
			s, h := startShellAtPrompt(t, path, c.args...)
			s.enter(t, h, codex)
			followAgent(t, h, s)
		})
	}
}

// A shell the machine holds back past the look Enter asked for, which finds it at its prompt and stops, starts its
// agent later: the agent's output brings the look that finds it (#1957).
func TestProcWatchFindsAgentStartedAfterTheFirstLook(t *testing.T) {
	codex := filepath.Join(t.TempDir(), "bin", "codex")
	copyBinary(t, codex)
	s, h := startShellAtPrompt(t, "/bin/sh", "-i")
	// Without the looks after Enter (#2048), only the agent's output can find it.
	h.pw.enteredFor = 0
	if err := s.cmd.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	s.enter(t, h, codex)
	waitShell(t, h, s, "the first look's end", func() bool { return h.next("b1").IsZero() })
	if err := s.cmd.Process.Signal(syscall.SIGCONT); err != nil {
		t.Fatal(err)
	}
	followAgent(t, h, s)
}

// The same late start with an agent that prints nothing (#2048): the looks Enter asked for go on while the shell is
// at its prompt, and find it. The window covers any delay here: the test checks the looks, not their duration.
func TestProcWatchFindsSilentAgentStartedAfterTheFirstLook(t *testing.T) {
	codex := filepath.Join(t.TempDir(), "bin", "codex")
	copyBinary(t, codex)
	s, h := startShellAtPrompt(t, "/bin/sh", "-i")
	h.pw.enteredFor = shellTestDeadline
	var looks atomic.Int32
	h.pw.readTable = func() (*proctree.Table, error) {
		looks.Add(1)
		return proctree.Read()
	}
	if err := s.cmd.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	if _, err := s.file.Write([]byte(fakeAgentEnv + "=" + fakeAgentSilent + " '" + codex + "'\r")); err != nil {
		t.Fatal(err)
	}
	h.states.input("b1", []byte("\r"))
	waitShell(t, h, s, "the first look", func() bool { return looks.Load() > 0 })
	if _, ok := h.states.runOf("b1"); ok {
		t.Fatal("the held-back shell runs no agent yet")
	}
	if err := s.cmd.Process.Signal(syscall.SIGCONT); err != nil {
		t.Fatal(err)
	}
	followAgent(t, h, s)
}

// startShellAtPrompt returns once the shell printed its prompt and reads what is typed: the process table shows it in
// the foreground from its very start, long before.
func startShellAtPrompt(t *testing.T, path string, args ...string) (*ptyShell, *procHarness) {
	t.Helper()
	s := startPtyShell(t, path, args...)
	h := makeProcHarness()
	h.pw.now = time.Now
	h.clock = time.Now()
	h.pw.readTable = proctree.Read
	h.pw.readArgs = readProcessArgs
	h.shells["b1"] = s.shell
	h.out("b1", "")
	waitShell(t, h, s, "the shell's prompt", func() bool {
		table, err := proctree.Read()
		return err == nil && !table.Running(s.shell.Pid) && h.next("b1").IsZero() && strings.Contains(s.printed.String(), shellPrompt)
	})
	if _, ok := h.states.runOf("b1"); ok {
		t.Fatal("a shell at its prompt runs no agent")
	}
	return s, h
}

// enter types a command and Enter in the terminal, as the terminal's input does.
func (s *ptyShell) enter(t *testing.T, h *procHarness, command string) {
	t.Helper()
	if _, err := s.file.Write([]byte("'" + command + "'\r")); err != nil {
		t.Fatal(err)
	}
	h.states.input("b1", []byte("\r"))
}

// followAgent waits for the fake Codex to be found as a running agent, kills it and waits for it to be forgotten.
func followAgent(t *testing.T, h *procHarness, s *ptyShell) {
	t.Helper()
	waitShell(t, h, s, "the agent's detection", func() bool {
		run, ok := h.states.runOf("b1")
		return ok && run.Agent == molten.AgentIdCodex && run.Running
	})
	killForeground(s.shell.Pid)
	waitShell(t, h, s, "the agent's end", func() bool {
		_, ok := h.states.runOf("b1")
		return !ok
	})
}
