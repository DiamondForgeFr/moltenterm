// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Who a pane's sub-agents are, read from disk (#1035): the one identity the Reviews view's agent lines, the Now card
// and the companion share. Claude Code: the agent-<id>.meta.json files of the parent session's subagents/ folder
// (agentType, worktreePath, description, finished) and the end of each agent's transcript for its model. Codex: the
// rollouts whose session_meta names the parent thread (#986), their latest turn's folder, model and end. The pane's
// SubagentStart/Stop hook reports (#988) fill in: a stop ends the agent, and a stop's transcript path gives the
// parent session when the pane has no linked one. Read only and bounded: small meta files, the last part of each
// transcript, cached by size and time; nothing of a transcript leaves the computer.

const (
	// The end of a sub-agent's transcript read for its model and folder.
	subagentIdentityTail = 64 * 1024
	// The sub-agents whose transcript is read per session, the most recently written first.
	maxIdentitySubagents = 24
	maxIdentityTailCache = 512
)

// SubagentIdentity is a sub-agent as its own files describe it.
type SubagentIdentity struct {
	AgentId     string
	Description string
	Kind        string
	Model       string
	// Worktree: the folder it works in (its worktree, else its records' cwd), as recorded.
	Worktree string
	Finished bool
	// State: SubagentRunning, SubagentQuiet (nothing written for SubagentQuietAfter) or SubagentDone.
	State   string
	Started int64
	// LastWrite: when it last wrote its transcript, or its end when a hook reported it, in Unix milliseconds.
	LastWrite int64
}

// SubagentLister is an adapter that lists a session's sub-agents from their own files.
type SubagentLister interface {
	ListSubagents(sessionPath string) []SubagentIdentity
}

// claudeSubagentMeta is what Claude Code writes next to a sub-agent's transcript.
type claudeSubagentMeta struct {
	AgentType    string `json:"agentType"`
	WorktreePath string `json:"worktreePath"`
	Description  string `json:"description"`
	ToolUseId    string `json:"toolUseId"`
	Finished     bool   `json:"finished"`
}

func readClaudeSubagentMeta(path string) (claudeSubagentMeta, bool) {
	var meta claudeSubagentMeta
	if readSmallJSON(path, claudeMaxMetaBytes, &meta) != nil {
		return claudeSubagentMeta{}, false
	}
	return meta, true
}

// claudeSubagentDir is the folder of a session's sub-agents: <slug>/<session>/subagents.
func claudeSubagentDir(sessionPath string) string {
	return filepath.Join(strings.TrimSuffix(sessionPath, ".jsonl"), "subagents")
}

// tailFacts is what the end of a sub-agent's transcript says: its latest model and effort, its folder, its end.
type tailFacts struct {
	model  string
	effort string
	cwd    string
	ended  bool
}

type tailCacheEntry struct {
	size  int64
	mod   int64
	facts tailFacts
}

var identityTails = struct {
	lock    sync.Mutex
	entries map[string]tailCacheEntry
}{entries: map[string]tailCacheEntry{}}

// cachedTail reads a transcript's tail facts again only when the file changed.
func cachedTail(path string, info os.FileInfo, read func() (tailFacts, bool)) (tailFacts, bool) {
	identityTails.lock.Lock()
	entry, ok := identityTails.entries[path]
	identityTails.lock.Unlock()
	if ok && entry.size == info.Size() && entry.mod == info.ModTime().UnixNano() {
		return entry.facts, true
	}
	facts, ok := read()
	if !ok {
		return tailFacts{}, false
	}
	identityTails.lock.Lock()
	defer identityTails.lock.Unlock()
	if len(identityTails.entries) >= maxIdentityTailCache {
		identityTails.entries = map[string]tailCacheEntry{}
	}
	identityTails.entries[path] = tailCacheEntry{size: info.Size(), mod: info.ModTime().UnixNano(), facts: facts}
	return facts, true
}

// claudeTailFacts reads, from the last records of a sub-agent's transcript, its latest model (the model's own
// answers), effort and cwd. ReadSubagent and ListSubagents share it.
func claudeTailFacts(tail []byte, wantCwd bool) tailFacts {
	var facts tailFacts
	lines := splitLines(tail)
	for i := len(lines) - 1; i >= 0; i-- {
		if facts.model != "" && facts.effort != "" && (!wantCwd || facts.cwd != "") {
			break
		}
		rec, ok := claudeTailRecord(lines[i])
		if !ok {
			continue
		}
		if facts.cwd == "" && rec.Cwd != "" {
			facts.cwd = rec.Cwd
		}
		if facts.effort == "" && rec.Effort != "" {
			facts.effort = cutString(rec.Effort, 40)
		}
		if facts.model == "" && rec.Message.Model != "" && !strings.HasPrefix(rec.Message.Model, "<") {
			facts.model = cutString(rec.Message.Model, 100)
		}
	}
	return facts
}

// ListSubagents lists the session's sub-agents from their meta files, the most recently written first.
func (a *ClaudeAdapter) ListSubagents(sessionPath string) []SubagentIdentity {
	if !strings.HasSuffix(sessionPath, ".jsonl") {
		return nil
	}
	dir := claudeSubagentDir(sessionPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type found struct {
		id    string
		meta  claudeSubagentMeta
		info  os.FileInfo
		write int64
	}
	var all []found
	for _, e := range entries {
		name := e.Name()
		agentId, ok := strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json")
		if !ok || !strings.HasPrefix(name, "agent-") || !claudeAgentIdRegex.MatchString(agentId) || !e.Type().IsRegular() {
			continue
		}
		if len(all) >= claudeMaxSubagentMetas {
			break
		}
		meta, ok := readClaudeSubagentMeta(filepath.Join(dir, name))
		if !ok {
			continue
		}
		f := found{id: agentId, meta: meta}
		if info, err := os.Lstat(filepath.Join(dir, "agent-"+agentId+".jsonl")); err == nil && info.Mode().IsRegular() {
			f.info, f.write = info, info.ModTime().UnixMilli()
		}
		all = append(all, f)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].write > all[j].write })
	if len(all) > maxIdentitySubagents {
		all = all[:maxIdentitySubagents]
	}
	rtn := make([]SubagentIdentity, 0, len(all))
	for _, f := range all {
		id := SubagentIdentity{
			AgentId: f.id, Description: cutString(oneLine(f.meta.Description), MaxSubagentText), Kind: cutString(f.meta.AgentType, 100),
			Worktree: f.meta.WorktreePath, Finished: f.meta.Finished, LastWrite: f.write,
		}
		if f.info != nil {
			path := filepath.Join(dir, "agent-"+f.id+".jsonl")
			facts, _ := cachedTail(path, f.info, func() (tailFacts, bool) {
				tail, err := readFileTail(path, subagentIdentityTail)
				if err != nil {
					return tailFacts{}, false
				}
				return claudeTailFacts(tail, true), true
			})
			id.Model = facts.model
			if id.Worktree == "" {
				id.Worktree = facts.cwd
			}
		}
		rtn = append(rtn, id)
	}
	return rtn
}

// ListSubagents lists the agents the session started, found by their rollouts' parent thread.
func (a *CodexAdapter) ListSubagents(sessionPath string) []SubagentIdentity {
	parent := SessionIdFromPath(molten.AgentIdCodex, sessionPath)
	if parent == "" {
		return nil
	}
	since := int64(0)
	if head, ok := a.head(sessionPath); ok {
		since = head.started
	}
	var rtn []SubagentIdentity
	for _, f := range a.FindSubagents(sessionPath, []string{parent}, since) {
		if f.Nested || len(rtn) >= maxIdentitySubagents {
			continue
		}
		id := SubagentIdentity{AgentId: f.AgentId, Description: cutString(f.Name, MaxSubagentText), Kind: cutString(f.Kind, 100), Started: f.Started}
		path, ok := a.subagentRollout(sessionPath, f.AgentId)
		if !ok {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		id.LastWrite = info.ModTime().UnixMilli()
		agentId := f.AgentId
		facts, _ := cachedTail(path, info, func() (tailFacts, bool) {
			tail, err := readFileTail(path, subagentIdentityTail)
			if err != nil {
				return tailFacts{}, false
			}
			var facts tailFacts
			if settings, ok := codexLastTurnSettings(tail, agentId); ok {
				facts.model, facts.effort = settings.Model, settings.Effort
			}
			cwd, ended, folders := codexLastTurn(tail)
			if cwd == "" {
				if head, ok := a.head(path); ok {
					cwd = head.cwd
				}
			}
			facts.cwd, facts.ended = codexWorkFolder(cwd, folders), ended
			return facts, true
		})
		id.Model, id.Finished, id.Worktree = facts.model, facts.ended, facts.cwd
		rtn = append(rtn, id)
	}
	return rtn
}

// identityState: finished, else quiet when it wrote nothing for SubagentQuietAfter, else running.
func identityState(id SubagentIdentity, now time.Time) string {
	if id.Finished {
		return SubagentDone
	}
	last := max(id.LastWrite, id.Started)
	if last > 0 && now.UnixMilli()-last > SubagentQuietAfter.Milliseconds() {
		return SubagentQuiet
	}
	return SubagentRunning
}

// ApplyHookSubagents takes the pane's hook reports into the listing: a reported stop ends its agent, at the stop's
// time when the files said nothing newer; a start after the last stop runs it again.
func ApplyHookSubagents(ids []SubagentIdentity, hooks []SubagentHookEvent, now time.Time) []SubagentIdentity {
	stopAt := map[string]int64{}
	startAt := map[string]int64{}
	for _, h := range hooks {
		if h.AgentId == "" {
			continue
		}
		if h.Event == molten.SubagentEventStop {
			stopAt[h.AgentId] = max(stopAt[h.AgentId], h.At)
		} else {
			startAt[h.AgentId] = max(startAt[h.AgentId], h.At)
		}
	}
	for i := range ids {
		id := &ids[i]
		if at, ok := stopAt[id.AgentId]; ok && at >= startAt[id.AgentId] {
			id.Finished = true
			if id.LastWrite == 0 || at < id.LastWrite {
				id.LastWrite = at
			}
		}
		id.State = identityState(*id, now)
	}
	return ids
}

// hookSessionPath is the parent session the pane's hook reports point to, validated as a transcript of the
// adapter's roots: a Claude Code stop names <slug>/<session>/subagents/agent-<id>.jsonl, a Codex report the parent
// thread's id.
func hookSessionPath(adapter Adapter, hooks []SubagentHookEvent) string {
	for i := len(hooks) - 1; i >= 0; i-- {
		h := hooks[i]
		if adapter.Id() == molten.AgentIdClaude && h.TranscriptPath != "" {
			subs := filepath.Dir(h.TranscriptPath)
			if filepath.Base(subs) != "subagents" {
				continue
			}
			if path, err := ValidateSessionPath(adapter, filepath.Dir(subs)+".jsonl"); err == nil {
				return path
			}
			continue
		}
		if finder, ok := adapter.(SessionFinder); ok && h.SessionId != "" {
			if path, ok := finder.FindSession(h.SessionId); ok && !finder.IsSubagent(path) {
				if valid, err := ValidateSessionPath(adapter, path); err == nil {
					return valid
				}
			}
		}
	}
	return ""
}

// PaneSubagents lists the sub-agents of the session a pane's agent runs, with their state; nil before Start.
func PaneSubagents(blockId string) []SubagentIdentity {
	m := defaultManager
	if m == nil {
		return nil
	}
	return m.PaneSubagents(blockId, HookSubagents(blockId))
}

func (m *Manager) PaneSubagents(blockId string, hooks []SubagentHookEvent) []SubagentIdentity {
	agent, path, ok := m.LinkedSession(blockId)
	if !ok && len(hooks) > 0 {
		agent = hooks[len(hooks)-1].Agent
		if agent == "" && m.runOf != nil {
			if run, ok := m.runOf(blockId); ok {
				agent = run.Agent
			}
		}
	}
	adapter := m.identityAdapter(agent)
	if adapter == nil {
		return nil
	}
	if !ok {
		path = hookSessionPath(adapter, hooks)
	}
	lister, isLister := adapter.(SubagentLister)
	if path == "" || !isLister {
		return nil
	}
	return ApplyHookSubagents(lister.ListSubagents(path), hooks, m.now())
}

// identityAdapter keeps one adapter per agent, so a Codex adapter's rollout headers stay cached between reads.
func (m *Manager) identityAdapter(agent string) Adapter {
	if agent == "" {
		return nil
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.identityAdapters == nil {
		m.identityAdapters = map[string]Adapter{}
	}
	if a, ok := m.identityAdapters[agent]; ok {
		return a
	}
	a := m.adapterFor(agent)
	if a != nil {
		m.identityAdapters[agent] = a
	}
	return a
}
