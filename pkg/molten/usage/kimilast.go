// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	// Kimi's token expires while Kimi Code does not run: the last reading it gave is kept in MoltenTerm's own data
	// folder, never under Kimi Code's, and shown again until a fresh one can be read (FR-SHELL-156, #2451). The
	// readings of every provider, Kimi's included, are the usage history (history.go).
	kimiLastDir      = "molten/usage"
	kimiLastFile     = "kimi-usage.json"
	kimiLastVersion  = 2
	kimiLastMaxBytes = 256 * 1024
	// Version 1 also held the per-day readings of the week deduced from the month (#2451), gone with #2532: its last
	// reading is still good.
	kimiLastOldestVersion = 1
)

type kimiLastDoc struct {
	Version int `json:"version"`
	// Last is the last reading the endpoint gave, shown again while the token has expired, a restart included.
	Last *UsageSnapshot `json:"last,omitempty"`
}

// kimiLast keeps the last reading in memory and in one file. An empty path keeps nothing (a test that gives none).
type kimiLast struct {
	lock   sync.Mutex
	path   func() string
	doc    *kimiLastDoc
	loaded string
}

func defaultKimiLastPath() string {
	dir := wavebase.GetWaveDataDir()
	// A test never writes in the data folder of the app it runs beside: it gives its own folder (UseForTest).
	if dir == "" || testing.Testing() {
		return ""
	}
	return filepath.Join(dir, kimiLastDir, kimiLastFile)
}

// docLocked loads the file once per path; a missing, unreadable or foreign file starts an empty document.
func (h *kimiLast) docLocked() (*kimiLastDoc, string) {
	path := ""
	if h.path != nil {
		path = h.path()
	}
	if path == "" {
		return nil, ""
	}
	if h.doc != nil && h.loaded == path {
		return h.doc, path
	}
	doc := &kimiLastDoc{Version: kimiLastVersion}
	if data, err := readBoundedRegularFile(path, kimiLastMaxBytes); err == nil {
		var read kimiLastDoc
		if json.Unmarshal(data, &read) == nil && read.Version >= kimiLastOldestVersion && read.Version <= kimiLastVersion {
			doc.Last = read.Last
		}
	}
	h.doc, h.loaded = doc, path
	return doc, path
}

func writeKimiLast(path string, doc *kimiLastDoc) error {
	data, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+kimiLastFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// record keeps the snapshot as the last reading.
func (h *kimiLast) record(snap UsageSnapshot) {
	h.lock.Lock()
	defer h.lock.Unlock()
	doc, path := h.docLocked()
	if doc == nil {
		return
	}
	last := cloneSnapshot(snap)
	last.Stale = ""
	doc.Last = &last
	doc.Version = kimiLastVersion
	writeKimiLast(path, doc)
}

// last is the last reading recorded, nil when there is none.
func (h *kimiLast) last() *UsageSnapshot {
	h.lock.Lock()
	defer h.lock.Unlock()
	doc, _ := h.docLocked()
	if doc == nil || doc.Last == nil {
		return nil
	}
	snap := cloneSnapshot(*doc.Last)
	return &snap
}

// clear forgets the reading and removes the file: turning the gauges off clears what they read (NFR-SHELL-011).
func (h *kimiLast) clear() {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.doc, h.loaded = nil, ""
	path := ""
	if h.path != nil {
		path = h.path()
	}
	if path == "" {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("molten usage: cannot remove the Kimi readings: %v\n", err)
	}
}
