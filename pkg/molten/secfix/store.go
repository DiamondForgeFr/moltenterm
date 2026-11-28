// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// The developer's answers about a check that looks like the project's scan (FR-REV-036 AC2): one per project and per
// check, kept in MoltenTerm's own data folder and never written into the repository.
const (
	AnswerConfirm = "confirm"
	AnswerDismiss = "dismiss"
	// AnswerReset withdraws an earlier answer.
	AnswerReset = "reset"
)

const maxCheckName = 200

type answers struct {
	Confirmed []string `json:"confirmed,omitempty"`
	Dismissed []string `json:"dismissed,omitempty"`
}

// Store keeps the answers of every project in one file.
type Store struct {
	lock sync.Mutex
	file string
}

func MakeStore(file string) *Store {
	return &Store{file: file}
}

func (s *Store) readLocked() map[string]answers {
	all := map[string]answers{}
	if data, err := os.ReadFile(s.file); err == nil {
		json.Unmarshal(data, &all)
	}
	return all
}

// Get returns the checks the developer confirmed and those they said are not the scan, for a project.
func (s *Store) Get(dir string) ([]string, []string) {
	if s == nil {
		return nil, nil
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	entry := s.readLocked()[filepath.Clean(dir)]
	return entry.Confirmed, entry.Dismissed
}

// Answer records the developer's answer about a check of a project.
func (s *Store) Answer(dir string, check string, answer string) error {
	if s == nil {
		return errors.New("the answers cannot be kept here")
	}
	name := strings.TrimSpace(spaceRe.ReplaceAllString(check, " "))
	if name == "" || len(name) > maxCheckName || strings.ContainsAny(name, "*\x00") {
		return errors.New("the check's name is not one MoltenTerm can keep")
	}
	if answer != AnswerConfirm && answer != AnswerDismiss && answer != AnswerReset {
		return errors.New("the answer must be confirm, dismiss or reset")
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	all := s.readLocked()
	key := filepath.Clean(dir)
	entry := all[key]
	entry.Confirmed = without(entry.Confirmed, name)
	entry.Dismissed = without(entry.Dismissed, name)
	switch answer {
	case AnswerConfirm:
		entry.Confirmed = append(entry.Confirmed, name)
	case AnswerDismiss:
		entry.Dismissed = append(entry.Dismissed, name)
	}
	sort.Strings(entry.Confirmed)
	sort.Strings(entry.Dismissed)
	if len(entry.Confirmed) == 0 && len(entry.Dismissed) == 0 {
		delete(all, key)
	} else {
		all[key] = entry
	}
	return s.writeLocked(all)
}

func without(list []string, name string) []string {
	var kept []string
	for _, item := range list {
		if normalizeName(item) != normalizeName(name) {
			kept = append(kept, item)
		}
	}
	return kept
}

func (s *Store) writeLocked(all map[string]answers) error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}
