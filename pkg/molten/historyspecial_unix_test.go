// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package molten

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Each no-writer FIFO case runs in a killable subprocess. A regression cannot strand a test goroutine or cleanup.
func TestHistorySpecialFilesDoNotBlock(t *testing.T) {
	for _, kind := range []string{"record-fifo", "record-socket", "snapshot-fifo", "snapshot-socket", "current-fifo", "state-fifo", "snapshot-state-fifo", "metadata-fifo", "metadata-socket", "marker-fifo", "root-fifo"} {
		t.Run(kind, func(t *testing.T) {
			root, err := os.MkdirTemp("/tmp", "mt979-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(root) })
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHistorySpecialFileProcess$")
			cmd.Env = append(os.Environ(), "MT_HISTORY_SPECIAL_FILE="+kind, "MT_HISTORY_SPECIAL_ROOT="+root)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("special-file process failed (deadline: %v): %v\n%s", ctx.Err(), err, output)
			}
		})
	}
}

func TestHistorySpecialFileProcess(t *testing.T) {
	kind := os.Getenv("MT_HISTORY_SPECIAL_FILE")
	if kind == "" {
		t.Skip("subprocess helper")
	}
	// A short Unix socket pathname also works on systems with a long per-user temporary-directory prefix.
	root := os.Getenv("MT_HISTORY_SPECIAL_ROOT")
	if root == "" {
		t.Fatal("missing parent-owned subprocess directory")
	}
	f := &historyFixture{
		t: t, modsDir: filepath.Join(root, "mods"), stateFile: filepath.Join(root, "config", StateFileName),
		now: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC),
	}
	f.h = MakeHistory(filepath.Join(root, "history"), f.modsDir, f.stateFile)
	f.write("a/main.js", "old")
	f.write("z/main.js", "old")
	f.setState(`{"enabled":["a"]}`)
	f.record(HistoryKindStart)
	f.write("a/main.js", "new")
	f.write("z/main.js", "new")
	f.write("added/main.js", "keep")
	f.setState(`{"enabled":["z"]}`)
	f.record(HistoryKindChange, "a", "z", "added")
	var target string
	switch {
	case strings.HasPrefix(kind, "record-"):
		target = filepath.Join(f.modsDir, "z/special")
	case strings.HasPrefix(kind, "snapshot-state-"):
		target = filepath.Join(f.h.Dir, "1", StateFileName)
	case strings.HasPrefix(kind, "snapshot-"):
		target = filepath.Join(f.h.Dir, "1", historyModsDir, "z/special")
	case kind == "current-fifo":
		target = filepath.Join(f.modsDir, "z/special")
	case kind == "state-fifo":
		target = f.stateFile
	case strings.HasPrefix(kind, "metadata-"):
		target = filepath.Join(f.h.Dir, "1", historyEntryFile)
	case kind == "marker-fifo":
		target = filepath.Join(f.h.Dir, historyRestoringMarker)
	case kind == "root-fifo":
		target = f.modsDir
	default:
		t.Fatal("unknown helper case")
	}
	if kind == "root-fifo" {
		if err := os.Rename(target, target+".saved"); err != nil {
			t.Fatal(err)
		}
	} else if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if strings.HasSuffix(kind, "socket") {
		listener, err := net.Listen("unix", target)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { listener.Close() })
	} else if err := syscall.Mkfifo(target, 0600); err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(kind, "record-") {
		if _, err := f.h.Record(HistoryKindChange, nil, 0, f.now); err == nil {
			t.Fatal("record must reject a special file")
		}
	} else if _, _, err := f.h.Undo(f.now); err == nil {
		t.Fatal("undo must reject a special file before restoring")
	}
	if kind != "root-fifo" {
		for rel, want := range map[string]string{"a/main.js": "new", "z/main.js": "new", "added/main.js": "keep"} {
			if got := f.read(rel); got != want {
				t.Fatalf("special-file failure changed %s: %q", rel, got)
			}
		}
	}
	if kind != "marker-fifo" {
		if _, err := os.Lstat(filepath.Join(f.h.Dir, historyRestoringMarker)); !os.IsNotExist(err) {
			t.Fatalf("failed preflight created a marker: %v", err)
		}
	}
}
