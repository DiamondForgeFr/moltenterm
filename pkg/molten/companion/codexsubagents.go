// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Codex's sub-agents (#986). The parent's rollout records each spawn_agent call (namespace "collaboration": task_name,
// agent_type, sometimes model and reasoning_effort, and an encrypted message that is never read), whose output names
// the agent's path ({"task_name":"/root/audit_reliability"}), then an item_completed SubAgentActivity item per step
// of the agent: started (with the call's id, the agent's thread id, model and effort), completed, interacted (a
// follow-up sent it back to work) and interrupted. Each sub-agent writes its own rollout next to its parent's, in
// the dated folder of its start; its session_meta says source.subagent.thread_spawn = {parent_thread_id, depth,
// agent_path, agent_nickname, agent_role} and its cwd. A sub-agent's own sub-agents (depth > 1) are recorded only in
// that sub-agent's rollout: they are found by their parent thread.

const (
	codexCollaboration = "collaboration"
	// The end of a main session's rollout read for the folder of its newest command (WorkFolder).
	codexSubagentTail = 512 * 1024
	// How much of a rollout's first line is read for its header, and how many headers are kept.
	codexHeadBytes    = 256 * 1024
	codexMaxHeadCache = 4000
	// The distinct folders of a sub-agent's latest shell commands kept to find its worktree (#1463).
	codexMaxCommandFolders = 8
)

var (
	codexTaskCompleteMarker = []byte(`"task_complete"`)
	codexTurnAbortedMarker  = []byte(`"turn_aborted"`)
	codexTaskStartedMarker  = []byte(`"task_started"`)
	codexTurnStartedMarker  = []byte(`"turn_started"`)
	codexTurnCompleteMarker = []byte(`"turn_complete"`)
	// A shell call's arguments are a JSON string inside the record: its keys are escaped there.
	codexWorkdirMarker     = []byte(`workdir`)
	codexWorkingDirMarker  = []byte(`"working_directory"`)
	codexExecCommandMarker = []byte(`"exec_command_`)
)

// codexHead is what a rollout's own session_meta says.
type codexHead struct {
	id       string
	parent   string
	path     string
	nickname string
	role     string
	cwd      string
	started  int64
	subagent bool
}

// codexAgentName is an agent's name for a reader: its task in readable form (audit_reliability → "audit
// reliability"), else its nickname.
func codexAgentName(path string, nickname string) string {
	task := path
	if i := strings.LastIndexByte(task, '/'); i >= 0 {
		task = task[i+1:]
	}
	task = strings.TrimSpace(strings.ReplaceAll(task, "_", " "))
	if task != "" {
		return task
	}
	return strings.TrimSpace(nickname)
}

// codexCollaborationArgs keeps a collaboration call's arguments without the message it sends the agent, which Codex
// encrypts: it is never shown, nor decoded.
func codexCollaborationArgs(parsed map[string]any) string {
	kept := make(map[string]any, len(parsed))
	for k, v := range parsed {
		if k == "message" || k == "items" {
			continue
		}
		kept[k] = v
	}
	return compactJSON(kept)
}

func (a *CodexAdapter) parseCollaboration(callId string, name string, args map[string]any, s *Session, at int64) {
	if name != "spawn_agent" {
		return
	}
	s.StartSubagent(callId, codexAgentName(str(args, "task_name"), ""), str(args, "agent_type"),
		codexSettingText(args["model"]), codexSettingText(args["reasoning_effort"]), true, at)
}

func (a *CodexAdapter) parseSubagentActivity(item map[string]any, s *Session, at int64) {
	thread := str(item, "agent_thread_id")
	path := str(item, "agent_path")
	switch str(item, "kind") {
	case "started":
		s.SubagentStarted(str(item, "id"), thread, path, codexAgentName(path, ""), codexSettingText(item["model"]), codexSettingText(item["reasoning_effort"]), at)
	case "completed":
		s.EndSubagent(thread, "completed")
	case "interrupted":
		s.EndSubagent(thread, "stopped")
	case "failed", "errored", "error":
		s.EndSubagent(thread, "failed")
	case "interacted":
		s.WakeSubagent(thread, at)
	}
}

// readCodexHead reads a rollout's own header: its first line.
func readCodexHead(path string) (codexHead, bool) {
	f, err := os.Open(path)
	if err != nil {
		return codexHead{}, false
	}
	defer f.Close()
	line, err := bufio.NewReaderSize(io.LimitReader(f, codexHeadBytes), 64*1024).ReadBytes('\n')
	if err != nil && err != io.EOF {
		return codexHead{}, false
	}
	var rec map[string]any
	if json.Unmarshal(bytes.TrimSpace(line), &rec) != nil || str(rec, "type") != "session_meta" {
		return codexHead{}, false
	}
	meta := obj(rec, "payload")
	head := codexHead{id: str(meta, "id"), cwd: str(meta, "cwd"), started: parseTime(str(meta, "timestamp")), subagent: codexSubagent(meta)}
	spawn := obj(obj(obj(meta, "source"), "subagent"), "thread_spawn")
	head.parent = str(spawn, "parent_thread_id")
	if head.parent == "" {
		head.parent = str(meta, "parent_thread_id")
	}
	head.path = str(spawn, "agent_path")
	head.nickname = str(spawn, "agent_nickname")
	head.role = str(spawn, "agent_role")
	return head, head.id != ""
}

func (a *CodexAdapter) head(path string) (codexHead, bool) {
	a.lock.Lock()
	head, ok := a.heads[path]
	a.lock.Unlock()
	if ok {
		return head, head.id != ""
	}
	head, _ = readCodexHead(path)
	a.keepHead(path, head)
	return head, head.id != ""
}

// keepHead caches a header; a rollout without a readable one yet (being written) is read again next time.
func (a *CodexAdapter) keepHead(path string, head codexHead) {
	if head.id == "" {
		return
	}
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.heads == nil || len(a.heads) >= codexMaxHeadCache {
		a.heads = map[string]codexHead{}
	}
	a.heads[path] = head
	if head.subagent {
		if a.rollouts == nil || len(a.rollouts) >= codexMaxHeadCache {
			a.rollouts = map[string]string{}
		}
		a.rollouts[strings.ToLower(head.id)] = path
	}
}

// subagentRollout finds a sub-agent's rollout by its thread id: its parent's folder first, then the dated folders.
func (a *CodexAdapter) subagentRollout(sessionPath string, agentId string) (string, bool) {
	if !codexThreadIdRegex.MatchString(agentId) {
		return "", false
	}
	a.lock.Lock()
	path, ok := a.rollouts[strings.ToLower(agentId)]
	a.lock.Unlock()
	if ok {
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
			return path, true
		}
	}
	path, ok = codexRolloutIn(filepath.Dir(sessionPath), "-"+strings.ToLower(agentId)+".jsonl")
	if !ok {
		path, ok = a.FindSession(agentId)
	}
	if !ok {
		return "", false
	}
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.rollouts == nil || len(a.rollouts) >= codexMaxHeadCache {
		a.rollouts = map[string]string{}
	}
	a.rollouts[strings.ToLower(agentId)] = path
	return path, true
}

// SubagentWritten reads when a sub-agent last wrote its rollout.
func (a *CodexAdapter) SubagentWritten(sessionPath string, agentId string) int64 {
	path, ok := a.subagentRollout(sessionPath, agentId)
	if !ok {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.ModTime().UnixMilli()
}

// SubagentIds: a Codex sub-agent's thread id comes with its started activity, or from FindSubagents.
func (a *CodexAdapter) SubagentIds(sessionPath string) map[string]string {
	return nil
}

// ReadSubagent reads a sub-agent's rollout: the model and effort of its latest settings, its branch from its own folder
// on disk (#967: its latest turn's cwd, else its header's), and whether its latest turn ended.
func (a *CodexAdapter) ReadSubagent(sessionPath string, agentId string) (SubagentFacts, bool) {
	path, ok := a.subagentRollout(sessionPath, agentId)
	if !ok {
		return SubagentFacts{}, false
	}
	turn, ok := a.scanRollout(path, agentId)
	if !ok {
		return SubagentFacts{}, false
	}
	facts := SubagentFacts{Model: turn.settings.Model, Effort: turn.settings.Effort, Ended: turn.ended}
	cwd := turn.cwd
	if cwd == "" {
		head, _ := a.head(path)
		cwd = head.cwd
	}
	facts.Worktree = codexWorkFolder(cwd, turn.folders)
	facts.Branch = FolderBranch(facts.Worktree)
	return facts, true
}

// codexWorkFolder is the folder a Codex agent works in (#1463). Codex starts a sub-agent in its parent's folder and
// gives it no folder of its own: one sent to a ticket's worktree runs each command there (a shell call's workdir)
// while its turns keep the parent's cwd, the main checkout's. The newest command folder in another checkout than its
// turn's folder is therefore its worktree; without one, its turn's folder. A command run in a subfolder of the turn's
// checkout, or outside any repository, names no other worktree.
func codexWorkFolder(cwd string, folders []string) string {
	turnGit := ""
	if filepath.IsAbs(cwd) {
		turnGit = findGitDir(filepath.Clean(cwd))
	}
	for _, f := range folders {
		if !filepath.IsAbs(f) {
			if !filepath.IsAbs(cwd) {
				continue
			}
			f = filepath.Join(cwd, f)
		}
		f = filepath.Clean(f)
		if git := findGitDir(f); git != "" && git != turnGit {
			return f
		}
	}
	return cwd
}

// codexCommandFolder reads the folder a shell command record runs in: a shell call's workdir, a local shell call's
// working_directory, an exec_command event's cwd, a finished command's cwd (the CommandExecution item codex-cli 0.166
// writes for every command, code mode's included); "" for any other record.
func codexCommandFolder(line []byte) string {
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Type      string          `json:"type"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
			Cwd       json.RawMessage `json:"cwd"`
			Action    json.RawMessage `json:"action"`
			Item      json.RawMessage `json:"item"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return ""
	}
	p := rec.Payload
	switch {
	case rec.Type == "response_item" && p.Type == "function_call" && codexShellTools[p.Name]:
		var args string
		var parsed struct {
			Workdir string `json:"workdir"`
		}
		if json.Unmarshal(p.Arguments, &args) != nil || json.Unmarshal([]byte(args), &parsed) != nil {
			return ""
		}
		return parsed.Workdir
	case rec.Type == "response_item" && p.Type == "local_shell_call":
		var action struct {
			WorkingDirectory string `json:"working_directory"`
		}
		if json.Unmarshal(p.Action, &action) != nil {
			return ""
		}
		return action.WorkingDirectory
	case rec.Type == "event_msg" && (p.Type == "exec_command_begin" || p.Type == "exec_command_end"):
		var cwd string
		if json.Unmarshal(p.Cwd, &cwd) != nil {
			return ""
		}
		return cwd
	case rec.Type == "event_msg" && p.Type == "item_completed":
		var item struct {
			Type string `json:"type"`
			Cwd  string `json:"cwd"`
		}
		if json.Unmarshal(p.Item, &item) != nil || item.Type != "CommandExecution" {
			return ""
		}
		return codexItemFolder(item.Cwd)
	}
	return ""
}

// codexItemFolder reads the folder a finished command's item names: a file:// URL since codex-cli 0.166 (spaces and
// the like percent-encoded), a plain path before. The URL of another computer names no folder here.
func codexItemFolder(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if !strings.HasPrefix(cwd, "file://") {
		return cwd
	}
	u, err := url.Parse(cwd)
	if err != nil || (u.Host != "" && u.Host != "localhost") {
		return ""
	}
	return u.Path
}

// codexCommandRecord tells, without decoding it, whether a line may be a shell command naming its folder.
func codexCommandRecord(line []byte) bool {
	return bytes.Contains(line, codexWorkdirMarker) || bytes.Contains(line, codexWorkingDirMarker) || bytes.Contains(line, codexExecCommandMarker) ||
		bytes.Contains(line, codexCommandExecutionMarker)
}

// FindSubagents reads the headers of the rollouts written since the given time in the dated folders from then on
// (and the session's own folder), and lists those whose parent thread is one of parents.
func (a *CodexAdapter) FindSubagents(sessionPath string, parents []string, since int64) []FoundSubagent {
	if len(parents) == 0 {
		return nil
	}
	wanted := map[string]bool{}
	for _, p := range parents {
		wanted[strings.ToLower(p)] = true
	}
	sessionId := strings.ToLower(SessionIdFromPath(molten.AgentIdCodex, sessionPath))
	now := time.Now()
	first := now.Add(-codexMaxDays * 24 * time.Hour)
	if since > 0 {
		if t := time.UnixMilli(since).Add(-24 * time.Hour); t.After(first) {
			first = t
		}
	}
	dirs := []string{filepath.Dir(sessionPath)}
	seen := map[string]bool{dirs[0]: true}
	for _, root := range a.roots {
		for day := first; !day.After(now.Add(24 * time.Hour)); day = day.Add(24 * time.Hour) {
			dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
			if !seen[dir] {
				seen[dir] = true
				dirs = append(dirs, dir)
			}
		}
	}
	minTime := time.UnixMilli(since).Add(-startSlack)
	var rtn []FoundSubagent
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if !e.Type().IsRegular() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			if since > 0 {
				if info, err := e.Info(); err != nil || info.ModTime().Before(minTime) {
					continue
				}
			}
			head, ok := a.head(filepath.Join(dir, name))
			// A reviewer (guardian) names its parent too, but no place in the agents' tree.
			if !ok || !head.subagent || head.path == "" || !wanted[strings.ToLower(head.parent)] {
				continue
			}
			rtn = append(rtn, FoundSubagent{
				AgentId: head.id, ParentId: head.parent, Path: head.path, Name: codexAgentName(head.path, head.nickname),
				Kind: head.role, Started: head.started, Nested: sessionId == "" || strings.ToLower(head.parent) != sessionId,
			})
		}
	}
	// A session that lives for days starts more agents than are kept: the newest are the ones still at work.
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].Started < rtn[j].Started })
	if len(rtn) > MaxSubagents {
		rtn = rtn[len(rtn)-MaxSubagents:]
	}
	return rtn
}
