// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentuse

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
)

// The record on disk: one file in MoltenTerm's data folder, never in a project. It is written by rename, so a write cut
// at any point leaves the previous one; the folder is 0700 and the file 0600.

const (
	dirMode     = 0o700
	fileMode    = 0o600
	fileName    = "agentuse.json"
	fileVersion = 1
	corruptMark = ".corrupt"
)

type File struct {
	Version int `json:"version"`
	// Agents: by agent id, then by the hour's number since the epoch.
	Agents map[string]map[string]bucket `json:"agents"`
}

func (r *Recorder) fileLocked() *File {
	file := &File{Version: fileVersion, Agents: make(map[string]map[string]bucket, len(r.hours))}
	for agent, byHour := range r.hours {
		out := make(map[string]bucket, len(byHour))
		for hour, b := range byHour {
			out[strconv.FormatInt(hour, 10)] = *b
		}
		file.Agents[agent] = out
	}
	return file
}

// Store is the file of the record.
type Store struct {
	dir string
}

func MakeStore(dir string) *Store {
	return &Store{dir: dir}
}

func (s *Store) path() string {
	return filepath.Join(s.dir, fileName)
}

// Load reads the record. A file that does not exist holds nothing; one that does not parse is set aside as
// agentuse.json.corrupt, and holds nothing either.
func (s *Store) Load() (File, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return File{}, nil
	}
	if err != nil {
		return File{}, err
	}
	var file File
	if err := json.Unmarshal(raw, &file); err != nil || file.Version != fileVersion {
		_ = os.Rename(s.path(), s.path()+corruptMark)
		return File{}, nil
	}
	return file, nil
}

func (s *Store) Save(file *File) error {
	if err := os.MkdirAll(s.dir, dirMode); err != nil {
		return err
	}
	raw, err := json.Marshal(file)
	if err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(s.path(), raw, fileMode)
}
