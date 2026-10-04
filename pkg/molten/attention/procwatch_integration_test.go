// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin || linux

package attention

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

const fakeAgentEnv = "MOLTEN_TEST_FAKE_AGENT"

// A copy of the test binary is the fake agent: started with fakeAgentEnv, it only waits (a copy of a system binary
// would not run on macOS, whose platform binaries are bound to their path).
func TestMain(m *testing.M) {
	if os.Getenv(fakeAgentEnv) != "" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// copyBinary makes a fake agent: a copy of the test binary under the agent's name.
func copyBinary(t *testing.T, dst string) {
	t.Helper()
	src, err := os.Executable()
	if err != nil {
		t.Skip("no test binary path")
	}
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	os.MkdirAll(filepath.Dir(dst), 0o755)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	out.Close()
}

// startShell runs a shell whose foreground command is the fake agent (the trailing `; exit` keeps the shell from
// exec-ing it: the agent is the shell's child, as in a terminal).
func startShell(t *testing.T, agent string) (*exec.Cmd, ShellProcess) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "'"+agent+"'; exit 0")
	cmd.Env = append(os.Environ(), fakeAgentEnv+"=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	pid := int32(cmd.Process.Pid)
	table, err := proctree.Read()
	if err != nil {
		t.Fatal(err)
	}
	return cmd, ShellProcess{BlockId: "b1", Pid: pid, StartMs: table.Get(pid).StartMs}
}

func waitRecord(t *testing.T, h *procHarness, want string) molten.AgentRunInfo {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.clock = time.Now()
		h.pw.pass()
		run, ok := h.states.runOf("b1")
		if want == "" && !ok {
			return run
		}
		if ok && run.Agent == want {
			return run
		}
		time.Sleep(100 * time.Millisecond)
	}
	run, ok := h.states.runOf("b1")
	table, _ := proctree.Read()
	sh := h.shells["b1"]
	if p := table.Get(sh.Pid); p != nil {
		t.Logf("shell %+v want start %d", *p, sh.StartMs)
	}
	for _, p := range table.Foreground(sh.Pid) {
		t.Logf("fg %+v", *p)
	}
	t.Fatalf("agent %q never found; last %+v %v", want, run, ok)
	return molten.AgentRunInfo{}
}

// The real process table, a real shell running a fake Claude Code: found by its name, then by its version-named
// binary; gone once killed, without any shell integration mark.
func TestProcWatchFakeAgentBinary(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		path string
	}{
		{filepath.Join(dir, "bin", "claude")},
		{filepath.Join(dir, ".local", "share", "claude", "versions", "2.1.283")},
	} {
		copyBinary(t, c.path)
		h := makeProcHarness()
		h.pw.now = time.Now
		h.clock = time.Now()
		h.pw.readTable = proctree.Read
		h.pw.readArgs = readProcessArgs
		_, shell := startShell(t, c.path)
		h.shells["b1"] = shell
		h.out("b1", cmdMark("./start-claude.sh"))
		run := waitRecord(t, h, "claude")
		if !run.Running || run.Started <= 0 || run.Started > time.Now().UnixMilli() {
			t.Errorf("%s: run %+v", c.path, run)
		}
		h.lock.Lock()
		h.shells["b1"] = shell
		h.lock.Unlock()
		table, _ := proctree.Read()
		for _, p := range table.Foreground(shell.Pid) {
			if p.Pid != shell.Pid {
				proc, _ := os.FindProcess(int(p.Pid))
				proc.Kill()
			}
		}
		waitRecord(t, h, "")
	}
}
