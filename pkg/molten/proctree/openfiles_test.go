// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestOpenFilesListsAnOpenFile(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("open files are not read on this platform")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-open.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	found := false
	for _, p := range OpenFiles(int32(os.Getpid())) {
		if p == path {
			found = true
		}
	}
	if !found {
		t.Fatalf("OpenFiles does not list %s", path)
	}
	if got := OpenFiles(0); got != nil {
		t.Fatalf("OpenFiles(0) = %v", got)
	}
}
