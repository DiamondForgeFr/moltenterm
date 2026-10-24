// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build unix

package stdinwatch

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const helperDirEnv = "MOLTEN_STDINWATCH_HELPER_DIR"

// A socketpair descriptor, as libuv gives wavesrv's stdin, whose open file is replaced under the reader the way a
// stray close of descriptor 0 inside wavesrv does: dup2 drops the socket and puts a write-only file there, so the
// read gets EBADF however the read and the replacement interleave, and the descriptor number stays owned by the test.
func TestReplacedDescriptorKeepsRunning(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	stdin := os.NewFile(uintptr(fds[0]), "stdin")
	peer := os.NewFile(uintptr(fds[1]), "peer")
	t.Cleanup(func() {
		stdin.Close()
		peer.Close()
	})
	rec := &recorder{}
	parent := makeFakeParent(true)
	done := startWatch(t, stdin, parent.check, rec)
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Dup2(int(devNull.Fd()), fds[0]); err != nil {
		t.Fatal(err)
	}
	devNull.Close()
	for i := 0; i < 3; i++ {
		select {
		case <-parent.polls:
		case <-time.After(testDeadline):
			t.Fatalf("the parent was not polled")
		}
	}
	lines, reasons, _ := rec.snapshot()
	if len(reasons) != 0 {
		t.Fatalf("shut down while the parent runs: %q", reasons)
	}
	if !strings.Contains(strings.Join(lines, ""), "bad file descriptor") {
		t.Fatalf("log does not name EBADF:\n%s", strings.Join(lines, ""))
	}
	parent.alive.Store(false)
	waitDone(t, done)
}

func TestParentWatcherSeesThisParent(t *testing.T) {
	if !ParentWatcher()() {
		t.Fatalf("the running parent reads as gone")
	}
}

func TestFd0StateNamesAnOpenDescriptor(t *testing.T) {
	if state := Fd0State(); state == "" {
		t.Fatalf("empty state")
	}
}

// TestHelperParentExit is the child of TestParentExitShutsDown: its stdin fails at once with EBADF, it survives that
// while its parent shell runs, and shuts down when the shell exits.
func TestHelperParentExit(t *testing.T) {
	dir := os.Getenv(helperDirEnv)
	if dir == "" {
		t.Skip("helper process only")
	}
	Watch(Config{
		Stdin:        &errReader{err: ebadf()},
		ParentAlive:  ParentWatcher(),
		PollInterval: 10 * time.Millisecond,
		Logf: func(format string, args ...any) {
			if strings.Contains(format, "end of goroutine dump") {
				os.WriteFile(filepath.Join(dir, "survived"), []byte("1"), 0600)
			}
		},
		Shutdown: func(reason string) {
			tmp := filepath.Join(dir, "reason.tmp")
			os.WriteFile(tmp, []byte(reason), 0600)
			os.Rename(tmp, filepath.Join(dir, "reason"))
			os.Exit(0)
		},
	})
}

// A real parent exit: the helper's parent shell waits until the helper survived its EBADF, then exits; the helper,
// given to init, must shut down on its own. The helper writes nothing after its reason, so the temp folder can go.
func TestParentExitShutsDown(t *testing.T) {
	dir := t.TempDir()
	script := `"$0" -test.run '^TestHelperParentExit$' -test.count=1 &
while [ ! -f "$1/survived" ] && [ ! -f "$1/reason" ]; do sleep 0.05; done`
	cmd := exec.Command("/bin/sh", "-c", script, os.Args[0], dir)
	cmd.Env = append(os.Environ(), helperDirEnv+"="+dir)
	if err := cmd.Run(); err != nil {
		t.Fatalf("parent shell: %v", err)
	}
	deadline := time.Now().Add(testDeadline)
	for {
		data, err := os.ReadFile(filepath.Join(dir, "reason"))
		if err == nil {
			if !strings.Contains(string(data), "parent exited") {
				t.Fatalf("reason = %q, want a parent-exited shutdown", data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the helper did not shut down after its parent exited")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
