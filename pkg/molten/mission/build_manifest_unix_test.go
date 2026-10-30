// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package mission

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestBuildManifestSpecialFiles(t *testing.T) {
	if dir := os.Getenv("MT_BUILD_MANIFEST_TEST_DIR"); dir != "" {
		fifo := filepath.Join(dir, "fifo")
		link := filepath.Join(dir, "manifest.json")
		if readBuildManifest(fifo) != nil || readBuildManifest(link) != nil {
			t.Fatal("FIFO accepted")
		}
		if readBuildManifest(filepath.Join(dir, "device")) != nil {
			t.Fatal("device accepted")
		}
		f, err := openBuildManifest(fifo)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		report := molten.ValidatePipeline(dir)
		if !report.Valid {
			t.Fatalf("pipeline invalid: %v", report.Errors)
		}
		r := MakeRuns(filepath.Join(dir, "runs"), nil, nil)
		r.git = func(context.Context, string, string, ...string) ([]byte, error) { return nil, errors.New("no git") }
		facts, err := r.BuildsFacts(dir, false)
		if err != nil || len(facts.Builds) != 1 || facts.Builds[0].Last != nil {
			t.Fatalf("facts: %+v, %v", facts, err)
		}
		regular := filepath.Join(dir, "swapped")
		if err := os.WriteFile(regular, []byte(`{"commit":"abc"}`), 0600); err != nil {
			t.Fatal(err)
		}
		result := readBuildManifestWithOpener(regular, func(path string) (*os.File, error) {
			if err := os.Remove(path); err != nil {
				return nil, err
			}
			if err := os.Symlink(fifo, path); err != nil {
				return nil, err
			}
			return openBuildManifest(path)
		})
		if result != nil {
			t.Fatal("FIFO substituted after stat accepted")
		}
		return
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".molten"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","builds":[{"id":"gold","run":"true","manifest":"manifest.json"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(fifo, filepath.Join(dir, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/null", filepath.Join(dir, "device")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestBuildManifestSpecialFiles$")
	cmd.Env = append(os.Environ(), "MT_BUILD_MANIFEST_TEST_DIR="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("special-file child: %v: %s", err, out)
	}
}
