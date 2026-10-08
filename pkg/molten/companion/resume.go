// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Restarting an agent on its own session (FR-SHELL-041's Update terminal; FR-CONT-010's Resume <previous agent>):
// the session a block's agent runs, as sure as the companion knows it. A hook report, a pick or discovery is sure; a
// guess is not, and the caller then reopens the agent's most recent session instead, saying so.

const resumePollInterval = 100 * time.Millisecond

// ResumeSession is the session a block's agent runs. Path is "" when none is known; Sure is false for a guess.
type ResumeSession struct {
	Path     string `json:"path,omitempty"`
	LinkedBy string `json:"linkedby,omitempty"`
	Sure     bool   `json:"sure,omitempty"`
}

func (w *watcher) resumeLink() (agent string, path string, linkedBy string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	return w.agent, w.path, w.linkedBy
}

// FindResumeSession looks for the session of a block's agent: what the companion already knows, else what its
// discovery finds within wait (the companion is opened for the time of the search, then closed).
func (m *Manager) FindResumeSession(blockId string, agent string, wait time.Duration) ResumeSession {
	if path := m.confidentPath(blockId); path != "" {
		if sameAgentPath(agent, path) {
			return ResumeSession{Path: path, LinkedBy: m.confidentKind(blockId), Sure: true}
		}
	}
	viewId := "resume:" + strconv.FormatInt(m.now().UnixNano(), 36)
	if _, err := m.Open(blockId, viewId); err != nil {
		return ResumeSession{}
	}
	defer m.Close(blockId, viewId)
	deadline := m.now().Add(wait)
	var found ResumeSession
	for {
		if w := m.watcher(blockId); w != nil {
			w.poke()
			wAgent, path, by := w.resumeLink()
			if path != "" && wAgent == agent {
				found = ResumeSession{Path: path, LinkedBy: by, Sure: by != LinkGuessed}
				if found.Sure {
					return found
				}
			}
		}
		if !m.now().Before(deadline) {
			return found
		}
		time.Sleep(resumePollInterval)
	}
}

// confidentKind names how confidentPath linked the block.
func (m *Manager) confidentKind(blockId string) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	if r, ok := m.reports[blockId]; ok && m.reportCurrentLocked(blockId, r) {
		return LinkHook
	}
	if _, ok := m.picks[blockId]; ok {
		return LinkPicked
	}
	return LinkDiscovery
}

// A path reported for another agent (a nested run) is not this agent's session.
func sameAgentPath(agent string, path string) bool {
	return SessionIdFromPath(agent, path) != ""
}

// FindResumeSession asks wavesrv's companion; without one (tests, a failed start) nothing is known.
func FindResumeSession(blockId string, agent string, wait time.Duration) ResumeSession {
	if defaultManager == nil {
		return ResumeSession{}
	}
	return defaultManager.FindResumeSession(blockId, agent, wait)
}

// SessionIdFromPath is the session id an agent resumes from its transcript's path: Claude Code's <id>.jsonl, Codex's
// rollout-<time>-<id>.jsonl. "" when the path is not one of that agent's transcripts.
func SessionIdFromPath(agent string, path string) string {
	name := filepath.Base(path)
	if !strings.HasSuffix(name, ".jsonl") {
		return ""
	}
	stem := strings.TrimSuffix(name, ".jsonl")
	switch agent {
	case molten.AgentIdClaude:
		if strings.HasPrefix(stem, "rollout-") || strings.HasPrefix(stem, "agent-") {
			return ""
		}
		if !claudeSessionIdRegex.MatchString(stem) {
			return ""
		}
		return stem
	case molten.AgentIdCodex:
		if !strings.HasPrefix(stem, "rollout-") || len(stem) < 36 {
			return ""
		}
		id := stem[len(stem)-36:]
		if !codexThreadIdRegex.MatchString(id) {
			return ""
		}
		return id
	}
	return ""
}

// Claude Code names its transcripts after the session id, a UUID like a Codex thread id.
var claudeSessionIdRegex = codexThreadIdRegex
