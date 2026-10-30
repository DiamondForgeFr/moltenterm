// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPastCodexSearchKeepsNewestDaysAcrossRoots(t *testing.T) {
	oldRoot, newRoot, project := t.TempDir(), t.TempDir(), t.TempDir()
	start := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < maxPastCodexDays; i++ {
		dir := filepath.Join(oldRoot, start.AddDate(0, 0, i).Format("2006/01/02"))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			head := fmt.Sprintf("{\"type\":\"session_meta\",\"payload\":{\"id\":\"old\",\"cwd\":%q}}\n", project)
			if err := os.WriteFile(filepath.Join(dir, "rollout-old.jsonl"), []byte(head), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	latest := filepath.Join(newRoot, start.AddDate(0, 0, maxPastCodexDays).Format("2006/01/02"))
	if err := os.MkdirAll(latest, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(latest, "rollout-latest.jsonl")
	head := fmt.Sprintf("{\"type\":\"session_meta\",\"payload\":{\"id\":\"test\",\"cwd\":%q}}\n", project)
	if err := os.WriteFile(path, []byte(head), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := PastSessionPaths(MakeCodexAdapter([]string{oldRoot, newRoot}), []string{project})
	if len(paths) != 1 || paths[0] != path {
		t.Fatalf("newest session missing: %v", paths)
	}
}
