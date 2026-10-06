// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// stackFrameSize: each level of fillStack takes at least this much of the goroutine's stack.
const stackFrameSize = 128

//go:noinline
func fillStack(depth int, f func()) byte {
	var pad [stackFrameSize]byte
	pad[depth%stackFrameSize] = byte(depth)
	if depth == 0 {
		f()
		return pad[0]
	}
	return fillStack(depth-1, f) + pad[depth%stackFrameSize]
}

// The process reads hand the kernel a buffer to fill. A buffer on the goroutine's stack moves when the stack grows
// during the call, and the kernel then writes into freed stack memory: the read comes back empty and another
// goroutine's stack is corrupted (#249, wavesrv's SIGSEGV in the sessions model). Each read here starts on a fresh
// goroutine at a different depth, so one of them grows the stack inside the call.
func TestProcessReadsSurviveStackGrowth(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("the process table is read on macOS and Linux only")
	}
	wantCwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	wantCwd, _ = filepath.EvalSymlinks(wantCwd)
	wantExe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	wantExe, _ = filepath.EvalSymlinks(wantExe)
	pid := int32(os.Getpid())
	for depth := 0; depth < 400; depth++ {
		var cwd, exe string
		done := make(chan struct{})
		go func() {
			defer close(done)
			fillStack(depth, func() { cwd = readProcessCwd(pid) })
		}()
		<-done
		done = make(chan struct{})
		go func() {
			defer close(done)
			fillStack(depth, func() { exe, _ = readProcessArgs(pid) })
		}()
		<-done
		if got, _ := filepath.EvalSymlinks(cwd); got != wantCwd {
			t.Fatalf("depth %d: cwd %q, want %q", depth, cwd, wantCwd)
		}
		if got, _ := filepath.EvalSymlinks(exe); got != wantExe {
			t.Fatalf("depth %d: exe %q, want %q", depth, exe, wantExe)
		}
	}
}
