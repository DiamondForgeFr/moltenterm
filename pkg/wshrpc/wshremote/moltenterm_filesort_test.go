// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// FR-FILE-003: a link to a folder is listed with the "directory" type, and stays a link (IsDir false).
func TestListEntriesMarksSymlinkedDir(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "realdir"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "realdir"), filepath.Join(root, "dirlink")); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "realdir"), filepath.Join(root, "dirlink.d")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "file.txt"), filepath.Join(root, "filelink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing"), filepath.Join(root, "brokenlink")); err != nil {
		t.Fatal(err)
	}

	impl := &ServerImpl{}
	ch := impl.RemoteListEntriesCommand(context.Background(), wshrpc.CommandRemoteListEntriesData{Path: root})
	byName := map[string]*wshrpc.FileInfo{}
	for resp := range ch {
		if resp.Error != nil {
			t.Fatalf("list error: %v", resp.Error)
		}
		for _, fi := range resp.Response.FileInfo {
			byName[fi.Name] = fi
		}
	}

	for _, name := range []string{"dirlink", "dirlink.d"} {
		if fi := byName[name]; fi == nil || fi.MimeType != "directory" || fi.IsDir || fi.Size != -1 {
			t.Fatalf("%s: want type directory and IsDir false, got %+v", name, fi)
		}
	}
	if fi := byName["realdir"]; fi == nil || fi.MimeType != "directory" || !fi.IsDir {
		t.Fatalf("realdir: want a folder, got %+v", fi)
	}
	if fi := byName["filelink"]; fi == nil || fi.MimeType == "directory" {
		t.Fatalf("filelink: a link to a file is not a folder, got %+v", fi)
	}
	if fi := byName["brokenlink"]; fi == nil || fi.MimeType == "directory" {
		t.Fatalf("brokenlink: a broken link is not a folder, got %+v", fi)
	}
}
