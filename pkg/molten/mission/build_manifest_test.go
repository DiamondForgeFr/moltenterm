// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildManifestRegularAndLimits(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "manifest.json")
	contents := `{"commit":"abc","version":"1.0.0"}`
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if got := readBuildManifest(path); got == nil || got.Commit != "abc" {
		t.Fatalf("manifest: %+v", got)
	}
	if readBuildManifest("") != nil || readBuildManifest(dir) != nil || readBuildManifest(filepath.Join(dir, "missing")) != nil {
		t.Fatal("empty, directory, or missing manifest accepted")
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Logf("symlink unavailable: %v", err)
	} else if got := readBuildManifest(link); got == nil || got.Commit != "abc" {
		t.Fatalf("symlink to regular manifest: %+v", got)
	}
	if err := os.WriteFile(path, []byte(`{"version":"1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if readBuildManifest(path) != nil {
		t.Fatal("manifest without commit accepted")
	}
	padded := contents + strings.Repeat(" ", maxBuildManifestBytes-len(contents))
	if err := os.WriteFile(path, []byte(padded), 0600); err != nil {
		t.Fatal(err)
	}
	if readBuildManifest(path) == nil {
		t.Fatal("manifest exactly at limit rejected")
	}
	if err := os.WriteFile(path, []byte(padded+" "), 0600); err != nil {
		t.Fatal(err)
	}
	if readBuildManifest(path) != nil {
		t.Fatal("oversize manifest accepted")
	}
	reader := &countManifestReader{remaining: maxBuildManifestBytes + 1024}
	if readBuildManifestBytes(reader) != nil || reader.consumed != maxBuildManifestBytes+1 {
		t.Fatalf("growing input: consumed %d, want %d", reader.consumed, maxBuildManifestBytes+1)
	}
	if readBuildManifestBytes(&errorManifestReader{}) != nil {
		t.Fatal("read error accepted")
	}
}

type countManifestReader struct{ remaining, consumed int }

func (r *countManifestReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := min(len(p), r.remaining)
	r.remaining -= n
	r.consumed += n
	return n, nil
}

type errorManifestReader struct{}

func (*errorManifestReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
