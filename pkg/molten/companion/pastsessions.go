// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Past sessions (FR-MAT-008): "Search past sessions" in the Materials section reads the transcripts the agents still
// keep for a project, once, on the developer's request. A transcript is read whole, read-only, through the same adapter
// as live capture; only the records that may carry a publication or a production address are decoded (plus the head,
// for the session's folder, first prompt and branch), so a project's gigabytes of transcripts read in seconds.

const (
	// The records read whole at the start of a transcript: its folder, branch and first prompt.
	pastHeadLines = 40
	// A longer record (a whole tool output) never carries a publication: skipped.
	pastLineMax = 8 * 1024 * 1024
	// The signals one transcript may give.
	MaxPastSignals = 5000
	// The transcripts one search reads at most, per agent.
	MaxPastSessions = 5000
	// The Codex day folders a search walks at most (one per day).
	maxPastCodexDays = 400
)

// The records that may carry a material's signal: Claude Code's publications (frame-link record, Artifact call and
// result) and its session titles. The addresses of the known hosts are added by the caller.
var pastMarkers = [][]byte{[]byte(`"frame-link"`), []byte(`"artifact_id"`), []byte(`"Artifact"`), []byte(`"ai-title"`), []byte(`"custom-title"`)}

// PastSession is what a finished transcript says of its materials: its signals (publications and addresses only),
// with the session's id, folder, subject, branch and ticket.
type PastSession struct {
	Path  string
	Agent string
	Batch MaterialBatch
}

// ReadPastSession reads a transcript of the agent for its materials; hosts are the production hosts whose addresses
// an answer may name (claude.ai).
func ReadPastSession(adapter Adapter, path string, hosts []string) (PastSession, error) {
	if adapter == nil {
		return PastSession{}, errors.New("no transcript reader")
	}
	li, err := os.Lstat(path)
	if err != nil {
		return PastSession{}, err
	}
	if li.Mode()&os.ModeSymlink != 0 || !li.Mode().IsRegular() {
		return PastSession{}, errors.New("not a regular session transcript")
	}
	f, err := os.Open(path)
	if err != nil {
		return PastSession{}, err
	}
	defer f.Close()
	markers := append([][]byte(nil), pastMarkers...)
	for _, h := range hosts {
		if h != "" {
			markers = append(markers, []byte(h+"/"))
		}
	}
	s := MakeLeanSession()
	var signals []MaterialSignal
	s.materialSink = func(sig MaterialSignal) {
		if (sig.Kind == SignalPublished || sig.Kind == SignalLinks) && len(signals) < MaxPastSignals {
			signals = append(signals, sig)
		}
	}
	branches := map[string]bool{}
	br := bufio.NewReaderSize(f, 256*1024)
	var line []byte
	skipping := false
	n := 0
	for {
		chunk, isPrefix, err := br.ReadLine()
		if err != nil {
			if err != io.EOF {
				return PastSession{}, err
			}
			break
		}
		if skipping {
			skipping = isPrefix
			continue
		}
		line = append(line, chunk...)
		if isPrefix {
			if len(line) > pastLineMax {
				line, skipping = line[:0], true
			}
			continue
		}
		n++
		if len(branches) < 2 {
			if b := recordBranch(line); b != "" && b != "HEAD" {
				branches[b] = true
			}
		}
		if n <= pastHeadLines || carriesAny(line, markers) {
			parseRecordLine(adapter, s, line)
		}
		line = line[:0]
	}
	s.materialSink = nil
	b := s.MaterialSignals(0)
	b.Signals, b.Seq = signals, 0
	if len(branches) > 1 {
		// Claude Code records the branch of whichever worktree its process last touched: a session that saw several
		// (the main checkout's, while its agents worked in worktrees) tells no ticket by its branch.
		b.Ticket = 0
		if s.firstPrompt != nil {
			b.Ticket = textTicket(s.firstPrompt.Text)
		}
	}
	if b.SessionId == "" && adapter.Id() == molten.AgentIdClaude {
		b.SessionId = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	}
	return PastSession{Path: path, Agent: adapter.Id(), Batch: b}, nil
}

var gitBranchMarker = []byte(`"gitBranch":"`)

// recordBranch reads a Claude Code record's gitBranch without decoding the record.
func recordBranch(line []byte) string {
	i := bytes.Index(line, gitBranchMarker)
	if i < 0 {
		return ""
	}
	rest := line[i+len(gitBranchMarker):]
	j := bytes.IndexByte(rest, '"')
	if j <= 0 || j > 250 {
		return ""
	}
	return string(rest[:j])
}

func carriesAny(line []byte, markers [][]byte) bool {
	for _, m := range markers {
		if bytes.Contains(line, m) {
			return true
		}
	}
	return false
}

// PastSessionPaths lists the transcripts of an agent that may belong to one of the folders (a project's main checkout
// and its worktrees), newest first. Claude Code names a session's folder after its working directory: the folder's
// own slug, or one starting with it for a folder under it (its agents' worktrees, <slug>--claude-worktrees-agent-…);
// sub-agents' transcripts sit in <session>/subagents/. Codex rollouts are kept when their session_meta folder is one
// of the folders or under one. The caller checks each transcript's own folder: a slug is not a path.
func PastSessionPaths(adapter Adapter, folders []string) []string {
	if adapter == nil {
		return nil
	}
	var found []pastFile
	switch adapter.Id() {
	case molten.AgentIdClaude:
		found = claudePastFiles(adapter.Roots(), folders)
	case molten.AgentIdCodex:
		found = codexPastFiles(adapter.Roots(), folders)
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].mod > found[j].mod })
	if len(found) > MaxPastSessions {
		found = found[:MaxPastSessions]
	}
	rtn := make([]string, len(found))
	for i, f := range found {
		rtn[i] = f.path
	}
	return rtn
}

type pastFile struct {
	path string
	mod  int64
}

func regularFile(path string) (int64, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.ModTime().UnixMilli(), true
}

func claudePastFiles(roots []string, folders []string) []pastFile {
	var slugs []string
	for _, folder := range folders {
		if folder != "" {
			slugs = append(slugs, ClaudeSlug(filepath.Clean(folder)))
		}
	}
	var rtn []pastFile
	seen := map[string]bool{}
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !claudeSlugMatches(e.Name(), slugs) {
				continue
			}
			dir := filepath.Join(root, e.Name())
			if seen[dir] {
				continue
			}
			seen[dir] = true
			rtn = append(rtn, claudeFolderFiles(dir)...)
		}
	}
	return rtn
}

func claudeSlugMatches(name string, slugs []string) bool {
	for _, slug := range slugs {
		if name == slug || strings.HasPrefix(name, slug+"-") {
			return true
		}
	}
	return false
}

// claudeFolderFiles: <dir>/<session>.jsonl and <dir>/<session>/subagents/agent-*.jsonl.
func claudeFolderFiles(dir string) []pastFile {
	var rtn []pastFile
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if e.Type().IsRegular() && strings.HasSuffix(name, ".jsonl") {
			path := filepath.Join(dir, name)
			if mod, ok := regularFile(path); ok {
				rtn = append(rtn, pastFile{path: path, mod: mod})
			}
			continue
		}
		if !e.IsDir() {
			continue
		}
		subs, err := os.ReadDir(filepath.Join(dir, name, "subagents"))
		if err != nil {
			continue
		}
		for _, sub := range subs {
			if !sub.Type().IsRegular() || !strings.HasPrefix(sub.Name(), "agent-") || !strings.HasSuffix(sub.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(dir, name, "subagents", sub.Name())
			if mod, ok := regularFile(path); ok {
				rtn = append(rtn, pastFile{path: path, mod: mod})
			}
		}
	}
	return rtn
}

func codexPastFiles(roots []string, folders []string) []pastFile {
	var rtn []pastFile
	days := 0
	for _, root := range roots {
		years, _ := os.ReadDir(root)
		for _, y := range years {
			if !y.IsDir() || !allDigits(y.Name(), 4) {
				continue
			}
			months, _ := os.ReadDir(filepath.Join(root, y.Name()))
			for _, m := range months {
				if !m.IsDir() || !allDigits(m.Name(), 2) {
					continue
				}
				dayDirs, _ := os.ReadDir(filepath.Join(root, y.Name(), m.Name()))
				for _, d := range dayDirs {
					if !d.IsDir() || !allDigits(d.Name(), 2) || days >= maxPastCodexDays {
						continue
					}
					days++
					dir := filepath.Join(root, y.Name(), m.Name(), d.Name())
					files, _ := os.ReadDir(dir)
					for _, f := range files {
						name := f.Name()
						if !f.Type().IsRegular() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
							continue
						}
						path := filepath.Join(dir, name)
						head, ok := readCodexHead(path)
						if !ok || !FolderWithin(head.cwd, folders) {
							continue
						}
						if mod, ok := regularFile(path); ok {
							rtn = append(rtn, pastFile{path: path, mod: mod})
						}
					}
				}
			}
		}
	}
	return rtn
}

// FolderWithin tells whether a folder is one of the folders or under one, by path (a removed worktree no longer
// resolves).
func FolderWithin(folder string, folders []string) bool {
	if folder == "" {
		return false
	}
	folder = filepath.Clean(folder)
	for _, f := range folders {
		if f == "" {
			continue
		}
		f = filepath.Clean(f)
		if folder == f || strings.HasPrefix(folder, f+string(filepath.Separator)) {
			return true
		}
		if real, err := filepath.EvalSymlinks(f); err == nil && real != f && (folder == real || strings.HasPrefix(folder, real+string(filepath.Separator))) {
			return true
		}
	}
	return false
}
