// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The global Codex reading (FR-SHELL-029, #2074): the plan is the account's, not a terminal's, so Brokk shows it in
// every workspace, with no Codex terminal open. It reads the last `rate_limits` Codex wrote into its newest rollouts,
// only their ends and only their token_count lines, else Codex's app-server.

const (
	// The newest rollouts by change time: a long session resumed today keeps its first day's folder.
	codexHomeFiles = 4
	// Only the end of a rollout is read; a token_count follows every model reply, so its last one sits there.
	codexHomeTailBytes = 8 * 1024 * 1024
	// Rollouts walked at most, so that a huge archive never holds the read.
	codexHomeMaxEntries = 50000
	// A home reading older than this lets the app-server read a fresher one, within its own limits.
	codexGlobalFreshAfter = time.Hour
)

// CodexHomeDir is Codex's folder on this computer: CODEX_HOME, else ~/.codex; "" when there is none.
func CodexHomeDir() string {
	home, _ := os.UserHomeDir()
	dir := molten.CodexHome(molten.AgentEnv{Home: home, Getenv: os.Getenv})
	if dir == "" {
		return ""
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return ""
	}
	return dir
}

type codexRollout struct {
	path     string
	modified time.Time
}

func newestCodexRollouts(home string) []codexRollout {
	var files []codexRollout
	entries := 0
	for _, sub := range []string{"sessions", "archived_sessions"} {
		root := filepath.Join(home, sub)
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if path == root {
					return fs.SkipAll
				}
				return nil
			}
			entries++
			if entries > codexHomeMaxEntries {
				return fs.SkipAll
			}
			if d.IsDir() || d.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			name := d.Name()
			if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			files = append(files, codexRollout{path: path, modified: info.ModTime()})
			return nil
		})
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].modified.After(files[j].modified) })
	if len(files) > codexHomeFiles {
		files = files[:codexHomeFiles]
	}
	return files
}

// readTail reads at most max bytes at the end of a file, from the first whole line.
func readTail(path string, max int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	start := int64(0)
	if info.Size() > max {
		start = info.Size() - max
	}
	buf, err := io.ReadAll(io.NewSectionReader(f, start, info.Size()-start))
	if err != nil {
		return nil
	}
	if start > 0 {
		nl := bytes.IndexByte(buf, '\n')
		if nl < 0 {
			return nil
		}
		buf = buf[nl+1:]
	}
	return buf
}

type codexTokenCount struct {
	Timestamp string `json:"timestamp"`
	Payload   struct {
		Type       string `json:"type"`
		RateLimits any    `json:"rate_limits"`
	} `json:"payload"`
}

type codexTimedLimits struct {
	rateLimits any
	at         int64
}

// tokenCounts reads only the lines that name a token_count: the rest of a rollout is the conversation, never parsed.
func tokenCounts(tail []byte) []codexTimedLimits {
	var rtn []codexTimedLimits
	for _, line := range bytes.Split(tail, []byte{'\n'}) {
		if !bytes.Contains(line, []byte(`"token_count"`)) {
			continue
		}
		var rec codexTokenCount
		if json.Unmarshal(line, &rec) != nil || rec.Payload.Type != "token_count" {
			continue
		}
		at := int64(0)
		if t, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
			at = t.UnixMilli()
		}
		rtn = append(rtn, codexTimedLimits{rateLimits: rec.Payload.RateLimits, at: at})
	}
	return rtn
}

// ReadCodexHomeLimits reads the plan limits Codex last wrote in its folder: the latest record of each bucket across
// its newest rollouts, by the records' own time. ok is false when the folder holds no rollout.
func ReadCodexHomeLimits(home string) (CodexTranscriptLimits, bool) {
	if home == "" {
		return CodexTranscriptLimits{}, false
	}
	files := newestCodexRollouts(home)
	if len(files) == 0 {
		return CodexTranscriptLimits{}, false
	}
	var all []codexTimedLimits
	for _, f := range files {
		all = append(all, tokenCounts(readTail(f.path, codexHomeTailBytes))...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].at < all[j].at })
	var lim CodexTranscriptLimits
	for _, r := range all {
		lim.Add(r.rateLimits, r.at)
	}
	return lim, true
}

// ReadGlobal reads Codex's plan limits for the whole app: the home's latest reading while its windows hold, else, or
// when it is over an hour old, the app-server within its limits (a process only when ctx allows one). A reading past
// its reset that nothing replaces gives "expired".
func (cu *CodexUsage) ReadGlobal(ctx context.Context, home string) (UsageSnapshot, error) {
	now := cu.now()
	nowMs := now.UnixMilli()
	lim, ok := ReadCodexHomeLimits(home)
	snap, err := cu.transcriptSnapshot(lim, ok)
	homeLive := err == nil && live(&snap, nowMs)
	if err == nil && !homeLive {
		err = Unavailable(ReasonExpired)
	}
	if homeLive && nowMs-snap.ReadAt <= codexGlobalFreshAfter.Milliseconds() {
		return snap, nil
	}
	cached, reason, run := cu.decide(false, !processAllowed(ctx) || !CanFetch(ctx), now)
	if run {
		app, appErr := cu.readAppServer(ctx)
		if appErr == nil {
			cached = &app
		} else {
			reason = ReasonOf(appErr)
		}
	}
	if live(cached, nowMs) && (!homeLive || cached.ReadAt > snap.ReadAt) {
		return *cached, nil
	}
	if homeLive {
		return snap, nil
	}
	if ReasonOf(err) == ReasonWaiting && reason != "" {
		return UsageSnapshot{}, Unavailable(reason)
	}
	return UsageSnapshot{}, err
}
