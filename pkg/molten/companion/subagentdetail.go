// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// A sub-agent's card (FR-SHELL-104, #1333): what the sidebar's sub-agent rows open. The companion's view already
// carries its description, type, model and times; its last message and transcript are read on demand, only when the
// card opens, from the sub-agent's own transcript. Provider-agnostic: an adapter only says where that transcript is,
// and its own Parse reads it, as it reads the main session's.

const (
	subagentDetailTailBytes = 256 * 1024
	// The card shows the start of the last message; the transcript holds the rest.
	maxSubagentLastMessage = 4000
)

// SubagentTranscriber is an adapter whose sub-agents write transcripts of their own (#1333).
type SubagentTranscriber interface {
	// SubagentTranscript gives the path of a sub-agent's transcript; false when it has none.
	SubagentTranscript(sessionPath string, agentId string) (string, bool)
}

// SubagentDetail is what a sub-agent's card reads beyond the view: its last message and its transcript's path, each
// empty when unknown.
type SubagentDetail struct {
	Id          string `json:"id"`
	LastMessage string `json:"lastmessage,omitempty"`
	Transcript  string `json:"transcript,omitempty"`
}

// SubagentTranscript: <session>/subagents/agent-<id>.jsonl, next to the session's transcript.
func (a *ClaudeAdapter) SubagentTranscript(sessionPath string, agentId string) (string, bool) {
	if !claudeAgentIdRegex.MatchString(agentId) || !strings.HasSuffix(sessionPath, ".jsonl") {
		return "", false
	}
	path := filepath.Join(strings.TrimSuffix(sessionPath, ".jsonl"), "subagents", "agent-"+agentId+".jsonl")
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return path, true
}

// SubagentTranscript: the sub-agent's own rollout, found by its thread id.
func (a *CodexAdapter) SubagentTranscript(sessionPath string, agentId string) (string, bool) {
	return a.subagentRollout(sessionPath, agentId)
}

// LastPromptAt: when the user's latest prompt was typed (0 before one): the sidebar folds the sub-agents that ended
// before it.
func (s *Session) LastPromptAt() int64 {
	if len(s.prompts) == 0 {
		return 0
	}
	return s.prompts[len(s.prompts)-1].At
}

func (m *Manager) SubagentDetail(blockId string, id string) (SubagentDetail, error) {
	w := m.watcher(blockId)
	if w == nil {
		return SubagentDetail{}, errNotOpen()
	}
	return w.subagentDetail(id)
}

func (w *watcher) subagentDetail(id string) (SubagentDetail, error) {
	sessionPath, agentId, callId, err := w.subagentIds(id)
	if err != nil {
		return SubagentDetail{}, err
	}
	rtn := SubagentDetail{Id: id}
	if agentId == "" {
		if reader, ok := w.adapter.(SubagentReader); ok {
			agentId = reader.SubagentIds(sessionPath)[callId]
		}
	}
	transcriber, ok := w.adapter.(SubagentTranscriber)
	if !ok || agentId == "" {
		return rtn, nil
	}
	path, ok := transcriber.SubagentTranscript(sessionPath, agentId)
	if !ok {
		return rtn, nil
	}
	rtn.Transcript = path
	rtn.LastMessage = lastMessageOf(w.adapter, path)
	return rtn, nil
}

func (w *watcher) subagentIds(id string) (sessionPath string, agentId string, callId string, err error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return "", "", "", errNoSession()
	}
	sa := w.session.subagent(id)
	if sa == nil {
		return w.path, "", "", nil
	}
	return w.path, sa.agentId, sa.id, nil
}

// lastMessageOf reads the end of a transcript with its adapter's parser and gives its latest answer, cut short.
func lastMessageOf(adapter Adapter, path string) string {
	tail, err := readFileTail(path, subagentDetailTailBytes)
	if err != nil {
		return ""
	}
	if info, err := os.Stat(path); err == nil && info.Size() > subagentDetailTailBytes {
		// The first line read is the end of a record cut in the middle.
		if cut := bytes.IndexByte(tail, '\n'); cut >= 0 {
			tail = tail[cut+1:]
		}
	}
	s := MakeLeanSession()
	for _, line := range bytes.Split(tail, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		// A very large record is a tool's output, never the agent's own words.
		if len(line) == 0 || len(line) > largeRecordBytes {
			continue
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		// Claude Code marks every record of a sub-agent's transcript as a side chain, which a main session's reading
		// skips: here the sub-agent is the main one.
		delete(rec, "isSidechain")
		adapter.Parse(rec, s)
	}
	answer, ok := s.Answer(0)
	if !ok {
		return ""
	}
	return cutRunes(strings.TrimSpace(answer.Markdown), maxSubagentLastMessage)
}
