// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"path/filepath"
	"strings"
)

// Which sub-agents run, from their own files (#2397). The parent's transcript tells a sub-agent's start and, most of
// the time, its end, but not always: a lead stops an agent with TaskStop after a "waiting on its own background work"
// notification and no end follows; the start of an agent lies before the part of a long transcript the companion reads
// (its last tailStartBytes); an agent resumed by SendMessage ends again later. The sub-agents' own files settle it:
// Claude Code marks a finished one in its meta file (claudeFinished), and one that runs keeps writing its transcript.

// SubagentFileLister is an adapter whose sub-agents' own files say whether they finished (SubagentIdentity.Finished,
// Ended) and when they last wrote: ListSubagents gives the most recently written, SubagentFile one of the others.
type SubagentFileLister interface {
	SubagentLister
	SubagentFile(sessionPath string, agentId string) (SubagentIdentity, bool)
}

// SubagentFile reads one sub-agent's meta file and its transcript's last write: Claude Code writes its end there.
func (a *ClaudeAdapter) SubagentFile(sessionPath string, agentId string) (SubagentIdentity, bool) {
	if !claudeAgentIdRegex.MatchString(agentId) || !strings.HasSuffix(sessionPath, ".jsonl") {
		return SubagentIdentity{}, false
	}
	dir := claudeSubagentDir(sessionPath)
	metaPath := filepath.Join(dir, "agent-"+agentId+".meta.json")
	info, err := os.Lstat(metaPath)
	if err != nil || !info.Mode().IsRegular() {
		return SubagentIdentity{}, false
	}
	meta, ok := readClaudeSubagentMeta(metaPath)
	if !ok {
		return SubagentIdentity{}, false
	}
	metaAt, written := info.ModTime().UnixMilli(), int64(0)
	if t, err := os.Lstat(filepath.Join(dir, "agent-"+agentId+".jsonl")); err == nil && t.Mode().IsRegular() {
		written = t.ModTime().UnixMilli()
	}
	return claudeIdentity(agentId, meta, metaAt, written), true
}

// settledAgentIds are the agent ids of the session's sub-agents still taken for running or quiet, which their files
// may have ended.
func (s *Session) settledAgentIds() []string {
	var rtn []string
	for _, sa := range s.subagents {
		if sa.agentId != "" && (sa.state == SubagentRunning || sa.state == SubagentQuiet) {
			rtn = append(rtn, sa.agentId)
		}
	}
	return rtn
}

// readSubagentFiles lists the most recently written sub-agents, and reads the files of the session's other running or
// quiet ones.
func readSubagentFiles(lister SubagentFileLister, path string, open []string) []SubagentIdentity {
	ids := lister.ListSubagents(path)
	listed := map[string]bool{}
	for _, id := range ids {
		listed[id.AgentId] = true
	}
	for _, agentId := range open {
		if listed[agentId] {
			continue
		}
		if id, ok := lister.SubagentFile(path, agentId); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// SettleSubagentFiles applies what the sub-agents' own files say: one they say finished after its latest start or
// wake ends; a running one the transcript never started (its call lies before the part read) is added. It tells
// whether anything changed. ReviveSubagents then runs again an ended agent that writes well after its end.
func (s *Session) SettleSubagentFiles(ids []SubagentIdentity, now int64) bool {
	changed := false
	for _, id := range ids {
		if id.AgentId == "" {
			continue
		}
		sa := s.subagent(id.AgentId)
		if sa == nil && id.CallId != "" {
			if sa = s.subagent(id.CallId); sa != nil && sa.agentId == "" {
				sa.agentId = cutString(id.AgentId, 200)
			}
		}
		if sa == nil && id.CallId == "" {
			sa = s.unnamedSubagent(id.Description)
			if sa != nil {
				sa.agentId = cutString(id.AgentId, 200)
			}
		}
		if sa == nil {
			if s.addFileSubagent(id, now) {
				changed = true
			}
			continue
		}
		if !id.Finished || (sa.state != SubagentRunning && sa.state != SubagentQuiet) {
			continue
		}
		// Claude Code marks the meta finished as any turn ends, also one that ends while the agent's own background
		// work runs on (#2498): the agent that waits on it ends only by a notification that it finished, or a TaskStop.
		if sa.waiting {
			continue
		}
		// A meta written well before the agent's latest start or wake is the end of an earlier run. Claude Code writes
		// the meta as the turn ends, a moment before the notification that wakes an agent waiting on its own work.
		if id.Ended > 0 && id.Ended+SubagentReviveAfter.Milliseconds() < max(sa.started, sa.woke) {
			continue
		}
		sa.state = SubagentDone
		sa.ended = max(sa.ended, id.Ended, id.LastWrite)
		changed = true
	}
	if changed {
		s.touch()
	}
	return changed
}

// unnamedSubagent is the one running call whose result has not yet named its agent and whose description is this
// one, nil when none or several match: files that do not name their call are matched by description alone.
func (s *Session) unnamedSubagent(description string) *subagent {
	description = cutRunes(oneLine(description), MaxSubagentText)
	if description == "" {
		return nil
	}
	var rtn *subagent
	for _, sa := range s.subagents {
		if sa.agentId != "" || sa.description != description || (sa.state != SubagentRunning && sa.state != SubagentQuiet) {
			continue
		}
		if rtn != nil {
			return nil
		}
		rtn = sa
	}
	return rtn
}

// addFileSubagent lists a sub-agent the transcript read never started, while its files say it runs. Its row takes the
// id of the call that started it when its files name it (#2468): Claude Code writes an agent's meta file as it
// launches it, and may write the call into the parent's transcript only once the whole message ends (the other calls
// of a message that launches several agents), so the call found later lands on this row instead of adding another.
func (s *Session) addFileSubagent(id SubagentIdentity, now int64) bool {
	if id.Finished || id.LastWrite <= 0 || now-id.LastWrite > SubagentQuietAfter.Milliseconds() {
		return false
	}
	agentId := cutString(id.AgentId, 200)
	rowId := agentId
	if id.CallId != "" {
		rowId = cutString(id.CallId, 200)
	}
	s.subagents = append(s.subagents, &subagent{
		id: rowId, agentId: agentId, description: cutRunes(oneLine(id.Description), MaxSubagentText),
		kind: cutString(id.Kind, 100), model: cutString(id.Model, 100), effort: cutString(id.Effort, 40),
		background: true, state: SubagentRunning, started: id.Started, found: true,
	})
	s.trimSubagents()
	return true
}
