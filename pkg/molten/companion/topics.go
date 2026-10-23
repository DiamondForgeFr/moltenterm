// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// The companion's recap (#555): the recent topics of the session, the agents at work and what the main one does now.
// Everything is read from the transcript, never written by a model: a topic is one of the user's own prompts whose
// turn did work, with the facts of that work; a sub-agent is what the main agent's own calls say of it.

const (
	// The topics kept per session (the latest ones), and how many a view carries.
	MaxTopics      = 50
	MaxShownTopics = 3
	MaxTopicRunes  = 240
	MaxTopicPRs    = 5
	// A prompt's turn with fewer tool calls than this and no file changed is a question or a follow-up, not a topic.
	topicMinTools = 3

	MaxSubagents        = 30
	MaxSubagentText     = 300
	MaxActivityRunes    = 160
	maxSessionNameRunes = 200

	// must match frontend/moltenterm-shell/companion/companion-recap-model.ts
	SubagentRunning = "running"
	SubagentDone    = "done"
	SubagentFailed  = "failed"
	SubagentStopped = "stopped"
	// SubagentQuiet: a background agent whose end the transcript never told and that wrote nothing for
	// SubagentQuietAfter (an interrupted run, a resumed session): not shown as at work, back to running if it writes.
	SubagentQuiet = "quiet"
)

// A background agent that wrote nothing for this long is no longer shown as running.
const SubagentQuietAfter = 30 * time.Minute

var (
	taskNotificationRegex = regexp.MustCompile(`(?s)<task-notification>.*?</task-notification>`)
	notificationToolRegex = regexp.MustCompile(`<tool-use-id>\s*([^<\s]{1,200})\s*</tool-use-id>`)
	// A notification about agents that ended with a previous run names them by their agent ids, several at once.
	notificationTaskRegex = regexp.MustCompile(`<task-id>\s*([^<\s]{1,200})\s*</task-id>`)
	notificationStatus    = regexp.MustCompile(`<status>\s*([a-z_]{1,40})\s*</status>`)
)

type topic struct {
	text   string
	branch string
	at     int64
	last   int64
	tools  int
	files  map[string]bool
	prs    []PRLink
}

type subagent struct {
	id string
	// agentId: the agent's own id (Claude Code's agentId), which names its transcript and some notifications.
	agentId     string
	description string
	kind        string
	model       string
	// effort: the effort its own transcript records, else the one its call asked for; empty when the parent's.
	effort string
	// branch: the branch its own transcript last names (a worktree's).
	branch     string
	background bool
	state      string
	started    int64
	ended      int64
	// woke: when a follow-up last sent it back to work (a Codex agent's "interacted" activity).
	woke   int64
	ticket ticketRef
	// path: the agent's place in its tree as Codex names it (/root/audit_reliability), which links a sub-agent
	// rollout to its call when no activity gave its thread id.
	path string
	// found: an agent read only from its own rollout (a sub-agent's sub-agent): its rollout's turns say its state.
	found bool
}

// PRLink is a pull request the session pushed, as the agent recorded it (Claude Code's pr-link records).
type PRLink struct {
	Number int    `json:"number"`
	Url    string `json:"url,omitempty"`
}

// TopicInfo is one recent topic: the user's prompt as typed (first lines) and what its work touched.
type TopicInfo struct {
	Text string `json:"text"`
	// Branch: the branch the agent worked on during this topic, as its records say.
	Branch string   `json:"branch,omitempty"`
	At     int64    `json:"at,omitempty"`
	Last   int64    `json:"last,omitempty"`
	Tools  int      `json:"tools,omitempty"`
	Files  int      `json:"files,omitempty"`
	PRs    []PRLink `json:"prs,omitempty"`
}

// SubagentInfo is a sub-agent or background agent the main agent started, as its own call describes it.
type SubagentInfo struct {
	Id          string `json:"id"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Model       string `json:"model,omitempty"`
	// Effort: empty when neither its transcript nor its call says it (the parent's then).
	Effort     string `json:"effort,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Background bool   `json:"background,omitempty"`
	State      string `json:"state"`
	Started    int64  `json:"started,omitempty"`
	Ended      int64  `json:"ended,omitempty"`
	// Ticket and Complexity: the ticket it works on and that ticket's complexity label (#601), kept on the agent's
	// entry for the model usage journal (#556).
	Ticket     int    `json:"ticket,omitempty"`
	Complexity string `json:"complexity,omitempty"`
}

// ActivityInfo is the main agent's latest tool call: the tool and what it was given (a command's description, a
// file, a pattern), never its output.
type ActivityInfo struct {
	Tool   string `json:"tool"`
	Target string `json:"target,omitempty"`
	At     int64  `json:"at,omitempty"`
}

// SetSessionName keeps the agent's own name of the session: Claude Code's ai-title, or the user's /rename (custom,
// which wins).
func (s *Session) SetSessionName(name string, custom bool) {
	name = strings.TrimSpace(oneLine(name))
	if name == "" || (!custom && s.customName) {
		return
	}
	name = cutRunes(name, maxSessionNameRunes)
	if name == s.name && custom == s.customName {
		return
	}
	s.name = name
	s.customName = s.customName || custom
	s.touch()
}

// SetBranch keeps the branch the agent's records say it works on; the current topic takes it too.
func (s *Session) SetBranch(branch string) {
	branch = strings.TrimSpace(branch)
	if branch == "" || branch == "HEAD" || branch == s.branch {
		return
	}
	s.branch = cutString(branch, 300)
	if t := s.currentTopic(); t != nil {
		t.branch = s.Branch()
	}
	s.touch()
}

// SetFolderBranch keeps the branch read from the session's folder on disk (#967), which wins over the records' from
// then on, even when empty (a detached HEAD): no stale ticket rather than another worktree's.
func (s *Session) SetFolderBranch(branch string) {
	branch = cutString(strings.TrimSpace(branch), 300)
	if s.folderRead && branch == s.folderBranch {
		return
	}
	s.folderRead, s.folderBranch = true, branch
	if t := s.currentTopic(); t != nil && branch != "" {
		t.branch = branch
	}
	s.touch()
}

// Branch is the branch the agent works on: its folder's when read, else what its records say.
func (s *Session) Branch() string {
	if s.folderRead {
		return s.folderBranch
	}
	return s.branch
}

// Name is the agent's own name of the session, empty when it gave none.
func (s *Session) Name() string {
	return s.name
}

func (s *Session) startTopic(text string, at int64) {
	t := &topic{text: cutRunes(text, MaxTopicRunes), branch: s.Branch(), at: at, last: at}
	s.topics = append(s.topics, t)
	if len(s.topics) > MaxTopics {
		s.topics = append([]*topic(nil), s.topics[len(s.topics)-MaxTopics:]...)
	}
}

func (s *Session) currentTopic() *topic {
	if len(s.topics) == 0 {
		return nil
	}
	return s.topics[len(s.topics)-1]
}

func (s *Session) topicTool(at int64) {
	t := s.currentTopic()
	if t == nil {
		return
	}
	t.tools++
	if at > 0 {
		t.last = at
	}
}

func (s *Session) topicFile(path string, at int64) {
	t := s.currentTopic()
	if t == nil {
		return
	}
	if t.files == nil {
		t.files = map[string]bool{}
	}
	if len(t.files) < MaxFiles {
		t.files[path] = true
	}
	if at > 0 {
		t.last = at
	}
}

// AddPRLink attaches a pull request to the topic during which the agent first recorded it.
func (s *Session) AddPRLink(number int, url string) {
	if number <= 0 {
		return
	}
	if s.prsSeen == nil {
		s.prsSeen = map[int]bool{}
	}
	if s.prsSeen[number] {
		return
	}
	s.prsSeen[number] = true
	t := s.currentTopic()
	if t == nil || len(t.prs) >= MaxTopicPRs {
		return
	}
	if !strings.HasPrefix(url, "https://") {
		url = ""
	}
	t.prs = append(t.prs, PRLink{Number: number, Url: cutString(url, 500)})
	s.touch()
}

func (t *topic) worked() bool {
	return len(t.files) > 0 || t.tools >= topicMinTools || len(t.prs) > 0
}

// Topics are the latest prompts whose turn did work, newest first.
func (s *Session) Topics() []TopicInfo {
	var rtn []TopicInfo
	for i := len(s.topics) - 1; i >= 0 && len(rtn) < MaxShownTopics; i-- {
		t := s.topics[i]
		if !t.worked() {
			continue
		}
		rtn = append(rtn, TopicInfo{Text: t.text, Branch: t.branch, At: t.at, Last: t.last, Tools: t.tools, Files: len(t.files), PRs: append([]PRLink(nil), t.prs...)})
	}
	return rtn
}

// NoteActivity keeps the main agent's latest tool call.
func (s *Session) NoteActivity(tool string, target string, at int64) {
	if tool == "" {
		return
	}
	s.activity = &ActivityInfo{Tool: cutString(tool, 200), Target: cutRunes(oneLine(target), MaxActivityRunes), At: at}
}

func (s *Session) Activity() *ActivityInfo {
	if s.activity == nil {
		return nil
	}
	a := *s.activity
	return &a
}

// StartSubagent records a sub-agent the main agent starts with one of its calls.
func (s *Session) StartSubagent(id string, description string, kind string, model string, effort string, background bool, at int64) {
	if id == "" {
		return
	}
	sa := s.subagent(id)
	if sa == nil {
		sa = &subagent{id: cutString(id, 200)}
		s.subagents = append(s.subagents, sa)
		s.trimSubagents()
	}
	sa.description = cutRunes(oneLine(description), MaxSubagentText)
	sa.kind = cutString(kind, 100)
	sa.model = cutString(model, 100)
	sa.effort = cutString(effort, 40)
	sa.background = background
	sa.state = SubagentRunning
	sa.started = at
	s.touch()
}

// subagent finds a sub-agent by its call's id, or by its own agent id.
func (s *Session) subagent(id string) *subagent {
	if id == "" {
		return nil
	}
	for _, sa := range s.subagents {
		if sa.id == id || sa.agentId == id {
			return sa
		}
	}
	return nil
}

// SetSubagentId keeps the agent id the result of a sub-agent's call gives it.
func (s *Session) SetSubagentId(callId string, agentId string) {
	sa := s.subagent(callId)
	if sa == nil || agentId == "" || sa.agentId == agentId {
		return
	}
	sa.agentId = cutString(agentId, 200)
}

// QuietSubagents settles the background agents whose end the transcript did not tell: one that wrote nothing for
// SubagentQuietAfter is quiet, a quiet one that writes again runs. lastWrite gives when an agent last wrote its own
// transcript (0 when unknown, then its start counts). It tells whether anything changed.
func (s *Session) QuietSubagents(now int64, lastWrite func(agentId string) int64) bool {
	changed := false
	for _, sa := range s.subagents {
		if !sa.background || (sa.state != SubagentRunning && sa.state != SubagentQuiet) {
			continue
		}
		last := max(sa.started, sa.woke)
		if sa.agentId != "" && lastWrite != nil {
			last = max(last, lastWrite(sa.agentId))
		}
		state := SubagentRunning
		if last > 0 && now-last > SubagentQuietAfter.Milliseconds() {
			state = SubagentQuiet
		}
		if state != sa.state {
			sa.state = state
			changed = true
		}
	}
	if changed {
		s.touch()
	}
	return changed
}

// SubagentResult reads the result of a sub-agent's call: a background agent's call returns at once (async) and the
// agent keeps running; any other result ends it.
func (s *Session) SubagentResult(id string, async bool, failed bool, model string) {
	sa := s.subagent(id)
	if sa == nil || sa.state != SubagentRunning {
		return
	}
	if model != "" && sa.model == "" {
		sa.model = cutString(model, 100)
	}
	if async {
		sa.background = true
		s.touch()
		return
	}
	sa.state = SubagentDone
	if failed {
		sa.state = SubagentFailed
	}
	sa.ended = s.recordAt
	s.touch()
}

// EndSubagent ends a background agent with the status its notification gives.
func (s *Session) EndSubagent(id string, status string) {
	sa := s.subagent(id)
	if sa == nil {
		return
	}
	state := SubagentDone
	switch status {
	case "failed", "error":
		state = SubagentFailed
	case "killed", "stopped", "cancelled", "canceled":
		state = SubagentStopped
	}
	if sa.state == state {
		return
	}
	sa.state = state
	sa.ended = s.recordAt
	s.touch()
}

// SubagentStarted records the thread a started sub-agent runs as (Codex's started activity, #986): the call that
// spawned it gets its agent id, and the model and effort the activity gives when the call named none. Without a
// recorded call (a version that wrote no spawn_agent), the activity starts the agent itself.
func (s *Session) SubagentStarted(callId string, agentId string, path string, description string, model string, effort string, at int64) {
	sa := s.subagent(callId)
	if sa == nil {
		sa = s.subagent(agentId)
	}
	if sa == nil {
		s.StartSubagent(callId, description, "", model, effort, true, at)
		sa = s.subagent(callId)
		if sa == nil {
			return
		}
	}
	s.SetSubagentId(sa.id, agentId)
	if sa.path == "" {
		sa.path = cutString(path, 300)
	}
	if sa.model == "" {
		sa.model = cutString(model, 100)
	}
	if sa.effort == "" {
		sa.effort = cutString(effort, 40)
	}
	s.touch()
}

// SetSubagentPath keeps where a sub-agent sits in its tree, as its call's result names it.
func (s *Session) SetSubagentPath(id string, path string) {
	sa := s.subagent(id)
	if sa == nil || path == "" || sa.path != "" {
		return
	}
	sa.path = cutString(path, 300)
}

// WakeSubagent sends an agent back to work: a follow-up its parent sent after it ended its task.
func (s *Session) WakeSubagent(id string, at int64) {
	sa := s.subagent(id)
	if sa == nil {
		return
	}
	sa.woke = max(sa.woke, at)
	if sa.state == SubagentRunning {
		return
	}
	sa.state = SubagentRunning
	sa.ended = 0
	s.touch()
}

// AddFoundSubagent takes an agent found by its own rollout. A child of the session itself only gives its thread id
// to the call that spawned it (matched by its path); a child of a sub-agent (nested) is listed with the others.
func (s *Session) AddFoundSubagent(f FoundSubagent) {
	if f.AgentId == "" || s.subagent(f.AgentId) != nil {
		return
	}
	if f.Path != "" {
		for _, sa := range s.subagents {
			if sa.agentId == "" && sa.path == f.Path {
				sa.agentId = cutString(f.AgentId, 200)
				return
			}
		}
	}
	if !f.Nested {
		return
	}
	s.subagents = append(s.subagents, &subagent{
		id: cutString(f.AgentId, 200), agentId: cutString(f.AgentId, 200), description: cutRunes(oneLine(f.Name), MaxSubagentText),
		kind: cutString(f.Kind, 100), background: true, state: SubagentRunning, started: f.Started, path: cutString(f.Path, 300), found: true,
	})
	s.trimSubagents()
	s.touch()
}

// The oldest ended sub-agents go first; running ones are kept.
func (s *Session) trimSubagents() {
	for len(s.subagents) > MaxSubagents {
		drop := 0
		for i, sa := range s.subagents {
			if sa.state != SubagentRunning {
				drop = i
				break
			}
		}
		s.subagents = append(s.subagents[:drop:drop], s.subagents[drop+1:]...)
	}
}

func (s *Session) Subagents() []SubagentInfo {
	rtn := make([]SubagentInfo, 0, len(s.subagents))
	for _, sa := range s.subagents {
		rtn = append(rtn, SubagentInfo{
			Id: sa.id, Description: sa.description, Kind: sa.kind, Model: sa.model, Effort: sa.effort, Branch: sa.branch,
			Background: sa.background, State: sa.state, Started: sa.started, Ended: sa.ended,
			Ticket: sa.ticket.number, Complexity: sa.ticket.complexity,
		})
	}
	return rtn
}

// taskNotifications reads the background agents' notifications a user record carries (Claude Code writes them as a
// message of the user): their call ids and statuses. ok tells the text is only notifications, not a prompt.
func taskNotifications(text string) (ends [][2]string, ok bool) {
	blocks := taskNotificationRegex.FindAllString(text, -1)
	if len(blocks) == 0 {
		return nil, false
	}
	for _, block := range blocks {
		status := ""
		if m := notificationStatus.FindStringSubmatch(block); m != nil {
			status = m[1]
		}
		if id := notificationToolRegex.FindStringSubmatch(block); id != nil {
			ends = append(ends, [2]string{id[1], status})
			continue
		}
		for _, id := range notificationTaskRegex.FindAllStringSubmatch(block, -1) {
			ends = append(ends, [2]string{id[1], status})
		}
	}
	rest := strings.TrimSpace(cleanTitleText(taskNotificationRegex.ReplaceAllString(text, " ")))
	return ends, rest == ""
}

// activityTarget is what a tool call was given, in the order a reader recognises it: a command's description, a
// file, a pattern, the command itself.
func activityTarget(input map[string]any) string {
	for _, key := range []string{"description", "file_path", "notebook_path", "path", "pattern", "query", "url", "command", "cmd"} {
		switch v := input[key].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v
			}
		case []any:
			if text := shellWords(v); text != "" {
				return text
			}
		}
	}
	return ""
}

// shellWords joins a command given as words; a "bash -lc <script>" wrapper shows its script.
func shellWords(words []any) string {
	parts := make([]string, 0, len(words))
	for _, w := range words {
		if s, ok := w.(string); ok {
			parts = append(parts, s)
		}
	}
	if len(parts) == 3 && (parts[1] == "-lc" || parts[1] == "-c") {
		return parts[2]
	}
	return strings.Join(parts, " ")
}

func cutRunes(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	return string([]rune(text)[:max-1]) + "…"
}
