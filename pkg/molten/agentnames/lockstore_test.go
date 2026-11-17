// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentnames

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLockStoreKeepsTheLocksInOrder(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "agentnames")
	store := MakeLockStore(dir)
	locks, err := store.Load()
	if err != nil || len(locks) != 0 {
		t.Fatalf("a store never written: %v %v", locks, err)
	}
	want := []Lock{{Name: "Alice", Project: projectA}, {Name: "Bruno", Project: projectB}, {Name: "Clara", Project: projectA}}
	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := MakeLockStore(dir).Load()
	if err != nil || len(got) != 3 {
		t.Fatalf("read back: %v %v", got, err)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("lock %d: %v, want %v", i, got[i], want[i])
		}
	}
}

func TestLockStoreIsPrivateToTheDeveloper(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "agentnames")
	store := MakeLockStore(dir)
	if err := store.Save([]Lock{{Name: "Alice", Project: projectA}}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("folder: %v %v", info, err)
	}
	if info, err := os.Stat(filepath.Join(dir, lockFileName)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file: %v %v", info, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("a write leaves only the file: %v %v", entries, err)
	}
}

func TestLockStoreSetsAsideAFileItCannotRead(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := MakeLockStore(dir)
	locks, err := store.Load()
	if err != nil || len(locks) != 0 {
		t.Fatalf("a corrupt file: %v %v", locks, err)
	}
	if _, err := os.Stat(path + lockCorruptMark); err != nil {
		t.Fatalf("the corrupt file was not set aside: %v", err)
	}
	if err := store.Save([]Lock{{Name: "Alice", Project: projectA}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + lockCorruptMark); err != nil {
		t.Fatalf("a later write lost the set-aside file: %v", err)
	}
}

func TestLockStoreEmptyListIsAnEmptyArray(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	store := MakeLockStore(dir)
	if err := store.Save(nil); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, lockFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"locks": []`) {
		t.Fatalf("file: %s", raw)
	}
}
