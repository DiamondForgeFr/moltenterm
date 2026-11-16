// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentnames

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
)

// The locked names on disk (DS-CONT-028, #2324): one file in MoltenTerm's data folder, keyed by each project's folder,
// never in a project's own files (a first name is the developer's own choice). The file is written by rename, so a
// write cut at any point leaves the previous one; the folder is 0700 and the file 0600.

const (
	lockDirMode     = 0o700
	lockFileMode    = 0o600
	lockFileName    = "locks.json"
	lockFileVersion = 1
	lockCorruptMark = ".corrupt"
)

type lockFile struct {
	Version int    `json:"version"`
	Locks   []Lock `json:"locks"`
}

// LockStore is the file of the locks. The caller serializes its calls: a write replaces the whole file.
type LockStore struct {
	dir string
}

func MakeLockStore(dir string) *LockStore {
	return &LockStore{dir: dir}
}

func (s *LockStore) path() string {
	return filepath.Join(s.dir, lockFileName)
}

// Load reads the locks in the order they were made. A file that does not exist holds none; one that does not parse is
// set aside as locks.json.corrupt, so the next write does not lose what it held, and holds none either.
func (s *LockStore) Load() ([]Lock, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var data lockFile
	if err := json.Unmarshal(raw, &data); err != nil || data.Version != lockFileVersion {
		_ = os.Rename(s.path(), s.path()+lockCorruptMark)
		return nil, nil
	}
	return data.Locks, nil
}

func (s *LockStore) Save(locks []Lock) error {
	if err := os.MkdirAll(s.dir, lockDirMode); err != nil {
		return err
	}
	if locks == nil {
		locks = []Lock{}
	}
	raw, err := json.MarshalIndent(lockFile{Version: lockFileVersion, Locks: locks}, "", "  ")
	if err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(s.path(), raw, lockFileMode)
}
