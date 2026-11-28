// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
// rollouts whose session_meta names the parent thread (#986), their latest turn's folder, model and end, read from the
// whole rollout (#1967: a sub-agent's turn context lies far from the end of its file). The pane's
// SubagentStart/Stop hook reports (#988) fill in: a stop ends the agent, and a stop's transcript path gives the
// parent session when the pane has no linked one. Read only and bounded: small meta files, the last part of each
// Claude Code transcript, a Codex rollout by the bytes appended since the last read; nothing of a transcript leaves
// the computer.

const (
	// The end of a Claude Code sub-agent's transcript read for its model and folder.
	subagentIdentityTail = 64 * 1024
	// The sub-agents whose transcript is read per session, the most recent first.
	maxIdentitySubagents = 24
	maxIdentityTailCache = 512
)

// SubagentIdentity is a sub-agent as its own files describe it.
type SubagentIdentity struct {
	AgentId     string
	Description string
	Kind        string
	Model       string
	// Effort: the latest effort level its transcript recorded, "" when none (#1756: its signature).
	Effort string
	// Worktree: the folder it works in (its worktree, else its records' cwd), as recorded.
	Worktree string
	Finished bool
	// State: SubagentRunning, SubagentQuiet (nothing written for SubagentQuietAfter) or SubagentDone.
	State   string
	Started int64
	// LastWrite: when it last wrote its transcript, or its end when a hook reported it, in Unix milliseconds.
	LastWrite int64
	// CallId: the parent's call that started it (Claude Code's toolUseId), "" when its files do not name it.
	CallId string
	// Ended: when its files say it finished (Claude Code: its meta file's write), 0 when they do not (#2397).
	Ended int64
	// Waiting: its last turn ended on background work of its own that has not reported yet (#2498): it runs on,
	// although its meta says finished, and goes quiet only after SubagentWaitingQuietAfter of silence.
	Waiting bool
	// Jobs: the background commands and monitors its transcript started and has not seen end, the oldest first (#2502).
	Jobs []molten.BackgroundJob
	// FirstWrite: when its transcript began, in Unix milliseconds, 0 when unknown (#2502): the age a window shows.
	FirstWrite int64
	// ParentId: the agent id of the sub-agent that started it (#2587), "" when the session itself did.
	ParentId string
}

// SubagentLister is an adapter that lists a session's sub-agents from their own files.
type SubagentLister interface {
	ListSubagents(sessionPath string) []SubagentIdentity
}

// claudeSubagentMeta is what Claude Code writes next to a sub-agent's transcript. A sub-agent's own sub-agents sit in
// the same subagents/ folder as the session's (#2587): their meta names the agent that started them (parentAgentId,
// Claude Code 2.1.332), absent for the session's own.
type claudeSubagentMeta struct {
	AgentType     string `json:"agentType"`
	WorktreePath  string `json:"worktreePath"`
	Description   string `json:"description"`
	ToolUseId     string `json:"toolUseId"`
	Finished      bool   `json:"finished"`
	ParentAgentId string `json:"parentAgentId"`
}

func readClaudeSubagentMeta(path string) (claudeSubagentMeta, bool) {
	var meta claudeSubagentMeta
	if readSmallJSON(path, claudeMaxMetaBytes, &meta) != nil {
		return claudeSubagentMeta{}, false
	}
	return meta, true
}

// claudeFinished is Claude Code's own word on a sub-agent's end (#2397): it writes "finished" into the meta file when
// the agent ends, and rewrites the file without it when SendMessage resumes the agent. A transcript written well after
// the meta is an agent that runs again, whatever the meta still says. The parent transcript is not needed: its end
// may lie before the part read, or a TaskStop ended the agent without a notification.
func claudeFinished(meta claudeSubagentMeta, metaAt int64, written int64) bool {
	return meta.Finished && written-metaAt <= SubagentReviveAfter.Milliseconds()
}

// claudeIdentity is a sub-agent as its meta file and its files' last writes describe it.
func claudeIdentity(agentId string, meta claudeSubagentMeta, metaAt int64, written int64) SubagentIdentity {
	id := SubagentIdentity{
		AgentId: agentId, Description: cutString(oneLine(meta.Description), MaxSubagentText), Kind: cutString(meta.AgentType, 100),
		Worktree: meta.WorktreePath, Finished: claudeFinished(meta, metaAt, written), LastWrite: written,
		CallId: cutString(meta.ToolUseId, 200),
	}
	if parent := meta.ParentAgentId; parent != agentId && claudeAgentIdRegex.MatchString(parent) {
		id.ParentId = parent
	}
	if id.Finished {
		id.Ended = metaAt
	}
	return id
}

// claudeSubagentEntry is a sub-agent's meta file in the session's subagents/ folder, with its files' last writes.
type claudeSubagentEntry struct {
	id     string
	metaAt int64
	// write: its transcript's last write, 0 without a transcript.
	write int64
	info  os.FileInfo
}

// claudeSubagentEntries lists the sub-agents of a session's subagents/ folder, the most recently written first, from
// the folder's listing alone (no file is read): a cap on the meta files read never drops a recent agent for one that
// ended long ago (#2397: the folder of a long lead session holds hundreds).
func claudeSubagentEntries(dir string) []claudeSubagentEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	transcripts := map[string]os.FileInfo{}
	var rtn []claudeSubagentEntry
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "agent-") || !e.Type().IsRegular() {
			continue
		}
		if agentId, ok := strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl"); ok && claudeAgentIdRegex.MatchString(agentId) {
			if info, err := e.Info(); err == nil {
				transcripts[agentId] = info
			}
			continue
		}
		agentId, ok := strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json")
		if !ok || !claudeAgentIdRegex.MatchString(agentId) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		rtn = append(rtn, claudeSubagentEntry{id: agentId, metaAt: info.ModTime().UnixMilli()})
	}
	for i := range rtn {
		if info, ok := transcripts[rtn[i].id]; ok {
			rtn[i].info, rtn[i].write = info, info.ModTime().UnixMilli()
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool {
		return max(rtn[i].write, rtn[i].metaAt) > max(rtn[j].write, rtn[j].metaAt)
	})
	return rtn
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
	// folders: the absolute folders its latest tool calls act in, the newest first (claudeToolFolders).
	folders []string
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
// answers), effort and cwd, and with wantFolders the folders its tool calls act in. ReadSubagent and ListSubagents
// share it.
func claudeTailFacts(tail []byte, wantCwd bool, wantFolders bool) tailFacts {
	var facts tailFacts
	lines := splitLines(tail)
	for i := len(lines) - 1; i >= 0; i-- {
		if facts.model != "" && facts.effort != "" && (!wantCwd || facts.cwd != "") && (!wantFolders || len(facts.folders) >= maxClaudeWorkFolders) {
			break
		}
		rec, ok := claudeTailRecord(lines[i])
		if !ok {
			continue
		}
		if wantFolders && len(facts.folders) < maxClaudeWorkFolders {
			found := claudeToolFolders(rec.Message.Content)
			for j := len(found) - 1; j >= 0 && len(facts.folders) < maxClaudeWorkFolders; j-- {
				facts.folders = append(facts.folders, found[j])
			}
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
	rtn := make([]SubagentIdentity, 0, maxIdentitySubagents)
	for _, f := range claudeSubagentEntries(dir) {
		if len(rtn) >= maxIdentitySubagents {
			break
		}
		meta, ok := readClaudeSubagentMeta(filepath.Join(dir, "agent-"+f.id+".meta.json"))
		if !ok {
			continue
		}
		id := claudeIdentity(f.id, meta, f.metaAt, f.write)
		if f.info != nil {
			path := filepath.Join(dir, "agent-"+f.id+".jsonl")
			facts, _ := cachedTail(path, f.info, func() (tailFacts, bool) {
				tail, err := readFileTail(path, subagentIdentityTail)
				if err != nil {
					return tailFacts{}, false
				}
				return claudeTailFacts(tail, true, true), true
			})
			id.Model, id.Effort = facts.model, facts.effort
			if id.Worktree == "" {
				id.Worktree = claudeSubagentWorkFolder(facts.cwd, facts.folders)
			}
			jobs := claudeBackgroundJobs(path, f.info)
			if id.Finished && len(jobs) > 0 {
				id.Finished, id.Ended, id.Waiting = false, 0, true
			}
			if !id.Finished && len(jobs) > 0 {
				id.Jobs = append([]molten.BackgroundJob(nil), jobs...)
			}
			id.FirstWrite = claudeTranscriptBegan(path)
		}
		id.Model, id.Effort = a.withAgentDefinition(id.Model, id.Effort, meta.AgentType, id.Worktree)
		rtn = append(rtn, id)
	}
	return rtn
}

// ListSubagents lists the agents the session started, found by their rollouts' parent thread, the newest first.
func (a *CodexAdapter) ListSubagents(sessionPath string) []SubagentIdentity {
	parent := SessionIdFromPath(molten.AgentIdCodex, sessionPath)
	if parent == "" {
		return nil
	}
	since := int64(0)
	if head, ok := a.head(sessionPath); ok {
		since = head.started
	}
	found := a.FindSubagents(sessionPath, []string{parent}, since)
	var rtn []SubagentIdentity
	for i := len(found) - 1; i >= 0 && len(rtn) < maxIdentitySubagents; i-- {
		f := found[i]
		if f.Nested {
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
		if turn, ok := a.scanRollout(path, f.AgentId); ok {
			cwd := turn.cwd
			if cwd == "" {
				if head, ok := a.head(path); ok {
					cwd = head.cwd
				}
			}
			id.Model, id.Effort, id.Finished = turn.settings.Model, turn.settings.Effort, turn.ended
			id.Worktree = codexWorkFolder(cwd, turn.folders)
		}
		rtn = append(rtn, id)
	}
	return rtn
}

// identityState: finished, else quiet when it wrote nothing for SubagentQuietAfter, else running.
func identityState(id SubagentIdentity, now time.Time) string {
	if id.Finished {
		return SubagentDone
	}
	quietAfter := SubagentQuietAfter
	if id.Waiting {
		quietAfter = SubagentWaitingQuietAfter
	}
	last := max(id.LastWrite, id.Started)
	if last > 0 && now.UnixMilli()-last > quietAfter.Milliseconds() {
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
		// A stop is not an end when the agent wrote its transcript well after it (#2397): an agent stops its turn and
		// goes on (its own background work, a SendMessage resume) without a new start.
		// Nor is the stop of a turn that ended on the agent's own background work (#2498).
		if at, ok := stopAt[id.AgentId]; ok && !id.Waiting && at >= startAt[id.AgentId] && id.LastWrite-at <= SubagentReviveAfter.Milliseconds() {
			id.Finished = true
			if id.LastWrite == 0 || at < id.LastWrite {
				id.LastWrite = at
			}
		}
		id.State = identityState(*id, now)
	}
	holdAwaitedParents(ids)
	return ids
}

// holdAwaitedParents keeps at work a sub-agent one of whose own sub-agents runs (#2587), waiting on them: the one rule
// Session.Subagents applies to the companion's rows.
func holdAwaitedParents(ids []SubagentIdentity) {
	byAgent := map[string]int{}
	for i, id := range ids {
		byAgent[id.AgentId] = i
	}
	awaited := map[string]bool{}
	for _, id := range ids {
		if id.State != SubagentRunning {
			continue
		}
		parent := id.ParentId
		for depth := 0; parent != "" && depth < maxSubagentDepth && !awaited[parent]; depth++ {
			awaited[parent] = true
			i, ok := byAgent[parent]
			if !ok {
				break
			}
			parent = ids[i].ParentId
		}
	}
	for i := range ids {
		id := &ids[i]
		if awaited[id.AgentId] && id.State != SubagentRunning {
			id.Finished, id.Ended, id.Waiting, id.State = false, 0, true, SubagentRunning
		}
	}
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
	hooks = m.runHooks(blockId, hooks)
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
	ids := ApplyHookSubagents(lister.ListSubagents(path), hooks, m.now())
	m.recordLeadWork(blockId, ids)
	return ids
}

// runHooks keeps the hook reports of the agent that runs in the block now (#2498): the block's log keeps every report
// until the terminal closes, so an agent run there before (a Claude Code session, then Kimi Code in the same
// terminal) would otherwise lend its session's sub-agents to the agent that runs now. A report names its agent; one
// from before the run's start is an earlier run's.
func (m *Manager) runHooks(blockId string, hooks []SubagentHookEvent) []SubagentHookEvent {
	if m.runOf == nil || len(hooks) == 0 {
		return hooks
	}
	run, ok := m.runOf(blockId)
	if !ok {
		return nil
	}
	since := time.UnixMilli(run.Started).Add(-reportSlack).UnixMilli()
	var rtn []SubagentHookEvent
	for _, h := range hooks {
		if (h.Agent != "" && h.Agent != run.Agent) || (run.Started > 0 && h.At < since) {
			continue
		}
		rtn = append(rtn, h)
	}
	return rtn
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
