// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func runLaunch(t *testing.T, cwd string, shellArgs []string) string {
	t.Helper()
	cmd, args := LocalJobLaunch("/bin/sh", shellArgs)
	c := exec.Command(cmd, args...)
	c.Env = append(os.Environ(), localJobCwdVarName+"="+cwd)
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("launch: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestLocalJobLauncherMovesToTheFolderThenBecomesTheShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix only")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	out := runLaunch(t, dir, []string{"-c", `pwd; echo "[$` + localJobCwdVarName + `]"; echo "$1|$2"`, "x", "a b", "c"})
	lines := strings.Split(out, "\n")
	if len(lines) != 3 || lines[0] != dir || lines[1] != "[]" || lines[2] != "a b|c" {
		t.Fatalf("got %q", out)
	}
}

func TestLocalJobLauncherFallsBackToHome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix only")
	}
	home, _ := os.UserHomeDir()
	home, _ = filepath.EvalSymlinks(home)
	out := runLaunch(t, filepath.Join(t.TempDir(), "gone"), []string{"-c", "pwd -P"})
	if out != home {
		t.Fatalf("got %q, want %q", out, home)
	}
}

// The job manager ignores SIGHUP; the shell it starts must not: closing the terminal has to end it.
func TestLocalJobLauncherRestoresHangup(t *testing.T) {
	if _, err := os.Stat(localJobZsh); err != nil {
		t.Skip("no zsh: the launcher cannot restore SIGHUP")
	}
	cmd, args := LocalJobLaunch("/bin/sh", []string{"-c", "kill -HUP $$; sleep 0.3; echo survived"})
	quoted := []string{}
	for _, a := range append([]string{cmd}, args...) {
		quoted = append(quoted, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
	}
	c := exec.Command("/bin/sh", "-c", "trap '' HUP; exec "+strings.Join(quoted, " "))
	c.Env = append(os.Environ(), localJobCwdVarName+"="+os.TempDir())
	out, _ := c.CombinedOutput()
	if strings.Contains(string(out), "survived") {
		t.Fatal("the shell kept the job manager's ignored SIGHUP")
	}
}

func TestLocalJobShellArgs(t *testing.T) {
	opts := CommandOptsType{Login: true, Interactive: true}
	if got := strings.Join(localJobShellArgs("/bin/zsh", "", opts), " "); got != "-l -i" {
		t.Errorf("zsh: %q", got)
	}
	if got := localJobShellArgs("/bin/bash", "", opts); len(got) != 2 || got[0] != "--rcfile" {
		t.Errorf("bash: %q", got)
	}
	if got := strings.Join(localJobShellArgs("/bin/zsh", "ls -la", opts), " "); got != "-c ls -la" {
		t.Errorf("command: %q", got)
	}
}

func TestLocalJobCompatible(t *testing.T) {
	current := &waveobj.Job{CmdEnv: map[string]string{LocalJobProtocolVarName: "1"}}
	if !LocalJobCompatible(current) {
		t.Error("same protocol must reattach")
	}
	if LocalJobCompatible(&waveobj.Job{CmdEnv: map[string]string{LocalJobProtocolVarName: "0"}}) || LocalJobCompatible(&waveobj.Job{}) || LocalJobCompatible(nil) {
		t.Error("another or missing protocol must not reattach")
	}
}
