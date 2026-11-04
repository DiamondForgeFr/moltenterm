// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bufio"
	"bytes"
	"encoding/json"
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
	// How much of a transcript's start is read for the folder it started in.
	pastHeadBytes = 1 << 20
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
// with the session's id, folder (the one it started in), subject, branch and ticket.
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
	if start := PastSessionFolder(adapter, path); start != "" {
		b.Cwd = start
	}
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

// PastSessionFolder is the folder a transcript's session started in: the first one its records name. Not the last: an
// agent that changes folder as it works (into a worktree, into another project's folder) still belongs to the project
// it was started in, which is also the one whose folder holds the transcript.
func PastSessionFolder(adapter Adapter, path string) string {
	if adapter == nil {
		return ""
	}
	if adapter.Id() == molten.AgentIdCodex {
		head, _ := readCodexHead(path)
		return head.cwd
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	br := bufio.NewReaderSize(io.LimitReader(f, pastHeadBytes), 64*1024)
	for n := 0; n < pastHeadLines; n++ {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, cwdMarker) {
			var rec struct {
				Cwd string `json:"cwd"`
			}
			if json.Unmarshal(line, &rec) == nil && rec.Cwd != "" {
				return rec.Cwd
			}
		}
		if err != nil {
			break
		}
	}
	return ""
}

var cwdMarker = []byte(`"cwd":`)

// FindPastSession is the transcript of a session id, for Claude Code (<project folder>/<id>.jsonl under its roots) and
// for the agents that can resolve one themselves (Codex).
func FindPastSession(adapter Adapter, id string) (string, bool) {
	if adapter == nil || id == "" {
		return "", false
	}
	if finder, ok := adapter.(SessionFinder); ok {
		return finder.FindSession(id)
	}
	if adapter.Id() != molten.AgentIdClaude || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		return "", false
	}
	for _, root := range adapter.Roots() {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			path := filepath.Join(root, e.Name(), id+".jsonl")
			if _, ok := regularFile(path); ok {
				return path, true
			}
		}
	}
	return "", false
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
// own slug, or, for a folder that is a repository, one starting with it for a folder under it (its agents' worktrees,
// <slug>--claude-worktrees-agent-…); a folder that is not a repository holds no project under it, whose slug merely
// starts with its own. Sub-agents' transcripts sit in <session>/subagents/. Codex rollouts are kept when their
// session_meta folder is one of the folders, or under one that is a repository. The caller checks each transcript's
// own folder: a slug is not a path.
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

type slugRule struct {
	slug string
	// nested: the folder is a repository, so a slug that continues the folder's is a folder under it (a subfolder, a
	// worktree) and not a project of its own.
	nested bool
}

func claudePastFiles(roots []string, folders []string) []pastFile {
	var slugs []slugRule
	for _, folder := range folders {
		if folder != "" {
			slugs = append(slugs, slugRule{slug: ClaudeSlug(filepath.Clean(folder)), nested: isRepoRoot(folder)})
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

func claudeSlugMatches(name string, slugs []slugRule) bool {
	for _, rule := range slugs {
		if name == rule.slug || rule.nested && strings.HasPrefix(name, rule.slug+"-") {
			return true
		}
	}
	return false
}

func isRepoRoot(folder string) bool {
	_, err := os.Stat(filepath.Join(folder, ".git"))
	return err == nil
}

// SessionFolderBelongs tells whether a session that started in cwd can belong to the project folder: it is the folder,
// or under it when the folder is a repository (a subfolder, a worktree). A folder that is not a repository is no
// parent project: the repositories under it are projects of their own, so a parent folder such as ~/Projects never
// swallows their sessions (#1816). The caller still places the session by its own folder.
func SessionFolderBelongs(project string, cwd string) bool {
	if project == "" || cwd == "" {
		return false
	}
	project, cwd = filepath.Clean(project), filepath.Clean(cwd)
	if cwd == project {
		return true
	}
	if !isRepoRoot(project) {
		return false
	}
	if strings.HasPrefix(cwd, project+string(filepath.Separator)) {
		return true
	}
	real, err := filepath.EvalSymlinks(project)
	return err == nil && real != project && (cwd == real || strings.HasPrefix(cwd, real+string(filepath.Separator)))
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
	type dayFolder struct{ date, path string }
	// Select across all roots before opening a day, so an older root cannot exhaust the scan budget.
	var days []dayFolder
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
					if !d.IsDir() || !allDigits(d.Name(), 2) {
						continue
					}
					day := dayFolder{date: y.Name() + m.Name() + d.Name(), path: filepath.Join(root, y.Name(), m.Name(), d.Name())}
					i := sort.Search(len(days), func(i int) bool {
						return days[i].date < day.date || days[i].date == day.date && days[i].path >= day.path
					})
					if i >= maxPastCodexDays {
						continue
					}
					days = append(days, dayFolder{})
					copy(days[i+1:], days[i:])
					days[i] = day
					if len(days) > maxPastCodexDays {
						days = days[:maxPastCodexDays]
					}
				}
			}
		}
	}
	var rtn []pastFile
	for _, day := range days {
		files, _ := os.ReadDir(day.path)
		for _, f := range files {
			name := f.Name()
			if !f.Type().IsRegular() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			path := filepath.Join(day.path, name)
			head, ok := readCodexHead(path)
			if !ok || !belongsToAny(folders, head.cwd) {
				continue
			}
			if mod, ok := regularFile(path); ok {
				rtn = append(rtn, pastFile{path: path, mod: mod})
			}
		}
	}
	return rtn
}

func belongsToAny(folders []string, cwd string) bool {
	for _, f := range folders {
		if SessionFolderBelongs(f, cwd) {
			return true
		}
	}
	return false
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
