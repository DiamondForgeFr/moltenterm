// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Claude Code runs its status line after every message, and the relay with it, while the rate limit windows change a
// few times an hour (FR-PERF-012, DS-PERF-011). The relay remembers, per pane, what it last handed over and does not
// connect to wavesrv again for the same windows. It still hands them over now and then, so the companion's "Updated"
// age and its staleness check (5 minutes) read as before, and sooner while the user does not show plan usage, so
// turning it on picks the windows up within seconds.

const (
	// must match usageRepublishInterval in pkg/molten/companion/usage.go: the companion republishes unchanged windows
	// at that pace.
	StatusLineResendAfter = 30 * time.Second
	// While wavesrv does not keep the windows (plan usage hidden).
	StatusLineResendAfterNotKept = 5 * time.Second
	// Records of panes long gone are removed when a new pane writes its first one.
	statusLineCacheMaxAge  = 24 * time.Hour
	statusLineCacheDirName = "statusline"
)

type statusLineSent struct {
	Req  AgentStatusLineRequest `json:"req"`
	At   int64                  `json:"at"`
	Kept bool                   `json:"kept"`
}

// StatusLineCacheDir is per user, outside the terminal's folder; empty when the system has none, and then the relay
// hands every run over, as before.
func StatusLineCacheDir() string {
	dir, err := os.UserCacheDir()
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "moltenterm", statusLineCacheDirName)
}

// statusLineCacheFile: block ids are uuids; anything else is not cached.
func statusLineCacheFile(dir string, blockId string) string {
	if dir == "" || blockId == "" || strings.ContainsAny(blockId, `/\.`) {
		return ""
	}
	return filepath.Join(dir, blockId+".json")
}

func readStatusLineSent(path string) (statusLineSent, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return statusLineSent{}, false
	}
	var sent statusLineSent
	if json.Unmarshal(data, &sent) != nil {
		return statusLineSent{}, false
	}
	return sent, true
}

func sameStatusLineRequest(a AgentStatusLineRequest, b AgentStatusLineRequest) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(ja, jb)
}

// StatusLineSendDue tells whether the relay hands req over: not when the pane's last hand-off had the same windows and
// is recent enough.
func StatusLineSendDue(dir string, req AgentStatusLineRequest, now time.Time) bool {
	path := statusLineCacheFile(dir, req.BlockId)
	if path == "" {
		return true
	}
	sent, ok := readStatusLineSent(path)
	if !ok || !sameStatusLineRequest(sent.Req, req) {
		return true
	}
	resendAfter := StatusLineResendAfter
	if !sent.Kept {
		resendAfter = StatusLineResendAfterNotKept
	}
	age := now.Sub(time.UnixMilli(sent.At))
	return age < 0 || age >= resendAfter
}

// RecordStatusLineSent remembers a hand-off wavesrv answered. Written to a temporary file and renamed: Claude Code may
// run the next status line while this one ends.
func RecordStatusLineSent(dir string, req AgentStatusLineRequest, kept bool, now time.Time) {
	path := statusLineCacheFile(dir, req.BlockId)
	if path == "" {
		return
	}
	data, err := json.Marshal(statusLineSent{Req: req, At: now.UnixMilli(), Kept: kept})
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	_, statErr := os.Stat(path)
	tmp, err := os.CreateTemp(dir, ".sent-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	_, werr := tmp.Write(data)
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		return
	}
	if os.Rename(tmp.Name(), path) != nil {
		return
	}
	if os.IsNotExist(statErr) {
		pruneStatusLineCache(dir, path, now)
	}
}

func pruneStatusLineCache(dir string, keep string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if path != keep && now.Sub(info.ModTime()) > statusLineCacheMaxAge {
			os.Remove(path)
		}
	}
}

// StatusLineKept reads wavesrv's answer; an answer without the field counts as kept.
func StatusLineKept(data json.RawMessage) bool {
	var resp struct {
		Kept *bool `json:"kept"`
	}
	if json.Unmarshal(data, &resp) != nil || resp.Kept == nil {
		return true
	}
	return *resp.Kept
}
