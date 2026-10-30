// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agenttoolkit

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestToolkitSpecialFiles(t *testing.T) {
	if path := os.Getenv("MT_TOOLKIT_FIFO_TEST"); path != "" {
		if readConfig(path) != nil {
			t.Fatal("FIFO accepted as config")
		}
		if _, ok := readSkillHead(path); ok {
			t.Fatal("FIFO accepted as skill")
		}
		f, err := openNoBlock(path)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		return
	}
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestToolkitSpecialFiles$")
	cmd.Env = append(os.Environ(), "MT_TOOLKIT_FIFO_TEST="+fifo)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("FIFO child: %v, %s", err, output)
	}
	device := filepath.Join(dir, "device")
	if err := os.Symlink("/dev/null", device); err != nil {
		t.Fatal(err)
	}
	if readConfig(device) != nil {
		t.Fatal("device accepted as config")
	}
	if _, ok := readSkillHead(device); ok {
		t.Fatal("device accepted as skill")
	}
	link := filepath.Join(dir, "linked-fifo")
	if err := os.Symlink(fifo, link); err != nil {
		t.Fatal(err)
	}
	if readConfig(link) != nil {
		t.Fatal("symlink to FIFO accepted as config")
	}
	if _, ok := readSkillHead(link); ok {
		t.Fatal("symlink to FIFO accepted as skill")
	}
}
