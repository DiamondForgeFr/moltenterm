// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func samePath(a string, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

func TestExeCwdSelf(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("read on macOS and Linux")
	}
	pid := int32(os.Getpid())
	wantExe, _ := os.Executable()
	wantCwd, _ := os.Getwd()
	if got := Exe(pid); !samePath(got, wantExe) {
		t.Fatalf("Exe: %q, want %q", got, wantExe)
	}
	if got := Cwd(pid); !samePath(got, wantCwd) {
		t.Fatalf("Cwd: %q, want %q", got, wantCwd)
	}
}

func TestExeCwdUnreadable(t *testing.T) {
	for _, pid := range []int32{0, -1, 1 << 30} {
		if got := Exe(pid); got != "" {
			t.Fatalf("Exe(%d): %q, want empty", pid, got)
		}
		if got := Cwd(pid); got != "" {
			t.Fatalf("Cwd(%d): %q, want empty", pid, got)
		}
	}
}
