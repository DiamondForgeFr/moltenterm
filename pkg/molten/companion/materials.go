// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What the materials registry reads of a session (FR-MAT-001, DS-MAT-002): the records that may show the developer a
// document, kept as a bounded list of signals the registry takes by sequence number. The adapters only say which
// records carry them (Claude Code: its publications; both: the answers' text); deciding what is a material, and
// copying it, is the registry's (pkg/molten/materials). Nothing here reads or copies a file.

const (
	// The registry takes the signals at every poll (5 s); a burst of files written fits.
	MaxMaterialSignals = 400
	// The last message of a turn kept for signal 3 (paths named in it), and all the texts kept together.
	MaxSignalText      = 32 * 1024
	maxSignalTextBytes = 128 * 1024
	maxSignalLinks     = 20
	// A publication's linked files, as its tool lists them.
	MaxSignalFiles   = 300
	maxPublishInputs = 50
)

// The kinds of signals.
const (
	// SignalPublished: a page published to the cloud (Claude Code's frame-link record and Artifact tool result).
	SignalPublished = "published"
	// SignalLinks: web addresses in an answer of the agent.
	SignalLinks = "links"
	// SignalAnswer: the last message of a turn.
	SignalAnswer = "answer"
	// SignalTurnEnd: the turn ended (the transcript says so).
	SignalTurnEnd = "turnend"
	// SignalWritten: a file the agent created (Claude Code's Write of a new file, Codex's apply_patch addition): a work
	// file unless a signal above shows it.
	SignalWritten = "written"
)

var webLinkRegex = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `)\]}]+`)

type MaterialSignal struct {
	Seq        int64    `json:"seq"`
	Kind       string   `json:"kind"`
	At         int64    `json:"at,omitempty"`
	Path       string   `json:"path,omitempty"`
	Url        string   `json:"url,omitempty"`
	Title      string   `json:"title,omitempty"`
	ArtifactId string   `json:"artifactid,omitempty"`
	Updated    bool     `json:"updated,omitempty"`
	Version    int      `json:"version,omitempty"`
	Files      []string `json:"files,omitempty"`
	// Sources: the source of a linked file the tool took from elsewhere, by its path relative to the page.
	Sources map[string]string `json:"sources,omitempty"`
	Links   []string          `json:"links,omitempty"`
	Text    string            `json:"text,omitempty"`
}

// MaterialBatch is the signals after a sequence number, with what the registry records of the session.
type MaterialBatch struct {
	Signals   []MaterialSignal
	Seq       int64
	SessionId string
	Cwd       string
	Subject   string
	Branch    string
	Ticket    int
}

func (s *Session) addMaterialSignal(sig MaterialSignal) {
	// Only the checkpoint's lean reader feeds the registry: the companion's own sessions keep none.
	if !s.lean {
		return
	}
	s.materialSeq++
	sig.Seq = s.materialSeq
	if sig.At == 0 {
		sig.At = s.recordAt
	}
	if s.materialSink != nil {
		s.materialSink(sig)
		return
	}
	s.materialSignals = append(s.materialSignals, sig)
	if len(s.materialSignals) > MaxMaterialSignals {
		s.materialSignals = dropOldestSignal(s.materialSignals)
	}
	// The newest texts are kept: the older ones were taken long ago.
	textBytes := 0
	for i := len(s.materialSignals) - 1; i >= 0; i-- {
		textBytes += len(s.materialSignals[i].Text)
		if textBytes > maxSignalTextBytes {
			s.materialSignals[i].Text = ""
		}
	}
}

// dropOldestSignal makes room in a full list: the oldest signal that is not a publication goes first, since a poll
// reading a long transcript at once (16 MB) gathers hundreds of answers, and a publication lost is a page lost.
func dropOldestSignal(signals []MaterialSignal) []MaterialSignal {
	drop := 0
	for i, sig := range signals {
		if sig.Kind != SignalPublished {
			drop = i
			break
		}
	}
	return append(signals[:drop:drop], signals[drop+1:]...)
}

// Publication is a page the agent published: its source path, its address, the title the tool gave, the tool's id of
// the page, whether it replaced an earlier version, the page's version number at its address (0 when the record does
// not say), its linked files (relative to the page's folder) and, for those the tool took from elsewhere, their
// sources.
type Publication struct {
	Path       string
	Url        string
	Title      string
	ArtifactId string
	Updated    bool
	Version    int
	Files      []string
	Sources    map[string]string
}

func (s *Session) NotePublication(p Publication, at int64) {
	if p.Url == "" || len(p.Url) > MaxPathBytes || len(p.Path) > MaxPathBytes {
		return
	}
	if len(p.Files) > MaxSignalFiles {
		p.Files = p.Files[:MaxSignalFiles]
	}
	s.addMaterialSignal(MaterialSignal{Kind: SignalPublished, At: at, Path: p.Path, Url: p.Url, Title: cutString(p.Title, 500), ArtifactId: cutString(p.ArtifactId, 200), Updated: p.Updated, Version: p.Version, Files: p.Files, Sources: p.Sources})
}

// noteLinks records the web addresses of an answer's text.
func (s *Session) noteLinks(text string, at int64) {
	if !strings.Contains(text, "://") {
		return
	}
	links := webLinkRegex.FindAllString(text, maxSignalLinks)
	if len(links) == 0 {
		return
	}
	for i := range links {
		links[i] = cutString(strings.TrimRight(links[i], ".,;:!?*_"), MaxPathBytes)
	}
	s.addMaterialSignal(MaterialSignal{Kind: SignalLinks, At: at, Links: links})
}

// closeTurnAnswer records the last message of the current turn once, and the turn's end when ended says so.
func (s *Session) closeTurnAnswer(ended bool) {
	cur := s.currentTurn()
	if cur != nil && cur.hasText && cur.index != s.answeredTurn {
		s.answeredTurn = cur.index
		s.addMaterialSignal(MaterialSignal{Kind: SignalAnswer, At: cur.at, Text: cutString(cur.markdown(), MaxSignalText)})
	}
	if ended {
		s.addMaterialSignal(MaterialSignal{Kind: SignalTurnEnd})
	}
}

// NoteTurnEnd: the agent's transcript says its turn ended (Claude Code's turn_duration), for the materials only; the
// turn's pending calls are left to the agent's hook (EndTurn is Codex's).
func (s *Session) NoteTurnEnd() {
	s.closeTurnAnswer(true)
}

// notePublishInput keeps the linked files a publishing call names, until its result arrives.
func (s *Session) notePublishInput(callId string, files map[string]string) {
	if !s.lean || callId == "" || len(files) == 0 {
		return
	}
	if s.publishInputs == nil || len(s.publishInputs) >= maxPublishInputs {
		s.publishInputs = map[string]map[string]string{}
	}
	s.publishInputs[callId] = files
}

func (s *Session) takePublishInput(callId string) map[string]string {
	files := s.publishInputs[callId]
	delete(s.publishInputs, callId)
	return files
}

// MaterialSignals returns the signals recorded after seq (all of them when seq is past the session's, a new
// transcript read from its start).
func (s *Session) MaterialSignals(after int64) MaterialBatch {
	if after > s.materialSeq {
		after = 0
	}
	b := MaterialBatch{Seq: s.materialSeq, SessionId: s.Id, Cwd: s.Cwd, Branch: s.Branch()}
	for _, sig := range s.materialSignals {
		if sig.Seq > after {
			b.Signals = append(b.Signals, sig)
		}
	}
	b.Subject = s.Name()
	if b.Subject == "" {
		b.Subject = s.Title()
	}
	text := ""
	if s.firstPrompt != nil {
		text = s.firstPrompt.Text
	}
	b.Ticket = resolveTicket(b.Branch, text)
	return b
}

// MaterialSignals is the reader's signals after seq, read by the last Poll.
func (r *SessionReader) MaterialSignals(after int64) MaterialBatch {
	b := r.session.MaterialSignals(after)
	if b.SessionId == "" && r.adapter.Id() == molten.AgentIdClaude {
		b.SessionId = strings.TrimSuffix(filepath.Base(r.Path), ".jsonl")
	}
	return b
}

// signalFiles reads a tool's list of files: strings, or objects with a path.
func signalFiles(values ...[]any) []string {
	var rtn []string
	seen := map[string]bool{}
	for _, list := range values {
		for _, v := range list {
			path := ""
			switch item := v.(type) {
			case string:
				path = item
			case map[string]any:
				path = str(item, "path")
			}
			if path == "" || len(path) > MaxPathBytes || seen[path] {
				continue
			}
			seen[path] = true
			rtn = append(rtn, path)
			if len(rtn) >= MaxSignalFiles {
				return rtn
			}
		}
	}
	return rtn
}
