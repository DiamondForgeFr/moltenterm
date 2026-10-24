// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The ticket each agent works on and its complexity (#601): the developer checks that an agent's model and effort are
// in proportion with its task. The ticket comes from the branch of the agent's own folder (gitbranch.go), else a #N
// in what it was asked (#967); its complexity is the sf-workflow's `complexity: …` label, read through the user's gh only
// when a companion that shows asks to look again, once per ticket while wavesrv runs (Epic #446: no poller).

const (
	// must match frontend/moltenterm-shell/companion/companion-proportion.ts
	ComplexityBug     = "bug"
	ComplexityLow     = "low"
	ComplexityMedium  = "medium"
	ComplexityComplex = "complex"

	ticketLookupTimeout = 20 * time.Second
	// At most this many gh calls run at once; a ticket left out is asked again at the next refresh.
	maxTicketLookups = 4
	// The tickets kept, answered or not; beyond it no new ticket is looked up.
	maxTicketCache = 500
	maxLabelBytes  = 256 * 1024
)

var (
	// The workflow's branch naming (feature/{N}-…, fix/{N}-…): the number is the ticket. Must match the frontend's.
	branchTicketRegex = regexp.MustCompile(`^(?:feature|fix)/(\d{1,9})(?:-|$)`)
	// A ticket named in a sentence: "#601", not "a#1" nor "&#39;".
	textTicketRegex      = regexp.MustCompile(`(?:^|[^\w&#/])#(\d{1,9})\b`)
	complexityLabelRegex = regexp.MustCompile(`(?i)^\s*complexity\s*:\s*(bug|low|medium|complex)\s*$`)
)

// ticketRef is the ticket an agent works on; checked: the complexity lookup of number answered (a label or none).
type ticketRef struct {
	number     int
	complexity string
	checked    bool
}

func branchTicket(branch string) int {
	m := branchTicketRegex.FindStringSubmatch(strings.TrimSpace(branch))
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func textTicket(text string) int {
	m := textTicketRegex.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// resolveTicket takes the ticket from the agent's own branch, then a #N in its own text (#967): a sub-agent never
// inherits its parent's, which would name another agent's ticket while it works on its own.
func resolveTicket(ownBranch string, text string) int {
	if n := branchTicket(ownBranch); n > 0 {
		return n
	}
	return textTicket(text)
}

// ComplexityOfLabels finds the workflow's complexity label among a ticket's labels; "" without one.
func ComplexityOfLabels(labels []string) string {
	for _, label := range labels {
		if m := complexityLabelRegex.FindStringSubmatch(label); m != nil {
			return strings.ToLower(m[1])
		}
	}
	return ""
}

// SetModelEffort keeps the main agent's model and effort as its latest answer records them.
func (s *Session) SetModelEffort(model string, effort string) {
	if strings.HasPrefix(model, "<") {
		// "<synthetic>": a message the agent wrote itself, not the model's.
		model = ""
	}
	changed := false
	if model != "" && model != s.model {
		s.model = cutString(model, 100)
		changed = true
	}
	if effort != "" && effort != s.effort {
		s.effort = cutString(effort, 40)
		changed = true
	}
	if changed {
		s.touch()
	}
}

func (s *Session) Model() string {
	return s.model
}

func (s *Session) Effort() string {
	return s.effort
}

// Ticket is the ticket the main agent works on and its complexity, when known.
func (s *Session) Ticket() (int, string) {
	return s.ticket.number, s.ticket.complexity
}

// subagentLink names a running sub-agent: its call's id and, once known, its own agent id.
type subagentLink struct {
	callId  string
	agentId string
	started int64
}

func (s *Session) runningSubagents() []subagentLink {
	var rtn []subagentLink
	for _, sa := range s.subagents {
		if sa.state == SubagentRunning {
			rtn = append(rtn, subagentLink{callId: sa.id, agentId: sa.agentId, started: sa.started})
		}
	}
	return rtn
}

// SetSubagentFacts takes what a sub-agent's own transcript says of it over what its call asked.
func (s *Session) SetSubagentFacts(callId string, facts SubagentFacts) {
	sa := s.subagent(callId)
	if sa == nil {
		return
	}
	changed := false
	set := func(field *string, value string) {
		if value != "" && value != *field {
			*field = value
			changed = true
		}
	}
	set(&sa.model, facts.Model)
	set(&sa.effort, facts.Effort)
	set(&sa.branch, facts.Branch)
	set(&sa.worktree, facts.Worktree)
	// Only an agent found by its rollout takes its state from it: a recorded one's parent tells its end and its
	// follow-ups, and a follow-up reaches the parent's records before the agent starts its next turn.
	if sa.found && facts.Ended && sa.state == SubagentRunning {
		sa.state = SubagentDone
		sa.ended = s.recordAt
		changed = true
	}
	if changed {
		s.touch()
	}
}

// ResolveTickets gives the main agent and each sub-agent its ticket and, once known, that ticket's complexity.
// complexity(number, fetch) answers from the cache (known false while it was never answered) and may ask for a lookup
// when fetch is set: only for the agents a companion shows (the main one and the running sub-agents).
func (s *Session) ResolveTickets(complexity func(number int, fetch bool) (string, bool)) {
	changed := false
	topic := ""
	if t := s.currentTopic(); t != nil {
		topic = t.text
	}
	changed = updateTicket(&s.ticket, resolveTicket(s.Branch(), topic), true, complexity) || changed
	for _, sa := range s.subagents {
		number := resolveTicket(sa.branch, sa.description)
		changed = updateTicket(&sa.ticket, number, sa.state == SubagentRunning, complexity) || changed
	}
	if changed {
		s.touch()
	}
}

func updateTicket(ref *ticketRef, number int, fetch bool, complexity func(number int, fetch bool) (string, bool)) bool {
	if number != ref.number {
		*ref = ticketRef{number: number}
		if number > 0 && complexity != nil {
			ref.complexity, ref.checked = complexity(number, fetch)
		}
		return true
	}
	if number == 0 || ref.checked || complexity == nil {
		return false
	}
	ref.complexity, ref.checked = complexity(number, fetch)
	return ref.checked
}

// complexityEntry is one ticket's lookup: done once gh answered (complexity empty without a label, or on failure).
type complexityEntry struct {
	complexity string
	done       bool
}

func complexityKey(dir string, number int) string {
	return dir + "\x00" + strconv.Itoa(number)
}

// ticketComplexity answers a ticket's complexity from the cache; with fetch, a ticket never asked is looked up in the
// background (the watchers are poked when it answers). A failed lookup is not tried again: one gh call per ticket.
func (m *Manager) ticketComplexity(dir string, number int, fetch bool) (string, bool) {
	if m.ticketLabels == nil || dir == "" || number <= 0 {
		return "", false
	}
	key := complexityKey(dir, number)
	m.lock.Lock()
	defer m.lock.Unlock()
	if e := m.complexities[key]; e != nil {
		return e.complexity, e.done
	}
	if !fetch || m.ticketLookups >= maxTicketLookups || len(m.complexities) >= maxTicketCache {
		return "", false
	}
	if m.complexities == nil {
		m.complexities = map[string]*complexityEntry{}
	}
	m.complexities[key] = &complexityEntry{}
	m.ticketLookups++
	go m.lookupComplexity(key, dir, number)
	return "", false
}

func (m *Manager) lookupComplexity(key string, dir string, number int) {
	defer func() {
		panichandler.PanicHandler("molten:companion:complexity", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), ticketLookupTimeout)
	defer cancel()
	labels, err := m.ticketLabels(ctx, dir, number)
	complexity := ""
	if err == nil {
		complexity = ComplexityOfLabels(labels)
	}
	m.setComplexity(key, complexity)
	m.pokeAll()
}

func (m *Manager) setComplexity(key string, complexity string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.ticketLookups--
	if e := m.complexities[key]; e != nil {
		e.complexity, e.done = complexity, true
	}
}

func (m *Manager) pokeAll() {
	m.lock.Lock()
	watchers := make([]*watcher, 0, len(m.watchers))
	for _, w := range m.watchers {
		watchers = append(watchers, w)
	}
	m.lock.Unlock()
	for _, w := range watchers {
		w.poke()
	}
}

// ghProgram finds the user's gh: wavesrv's PATH first (a Moltenterm started from a terminal), else the login
// shell's (one opened from the Finder has a bare PATH).
func ghProgram() (string, string) {
	if path, err := exec.LookPath("gh"); err == nil {
		return path, ""
	}
	loginPath := molten.LoginPath()
	return molten.LookPathIn("gh", loginPath), loginPath
}

// runGh runs the user's gh in the project's folder and returns its output, at most max bytes.
func runGh(ctx context.Context, dir string, max int, args ...string) ([]byte, error) {
	program, loginPath := ghProgram()
	if program == "" {
		return nil, fmt.Errorf("gh is not installed")
	}
	cmd := spawns.Command(ctx, program, args...)
	cmd.Dir = dir
	env := os.Environ()
	if loginPath != "" {
		env = append(env, "PATH="+loginPath)
	}
	// Nothing may wait for a prompt: wavesrv has no terminal.
	cmd.Env = append(env, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	if len(out) > max {
		return nil, fmt.Errorf("gh answer too large")
	}
	return out, nil
}

// GhIssueLabels reads a ticket's labels with `gh issue view N --json labels`, in the project's folder.
func GhIssueLabels(ctx context.Context, dir string, number int) ([]string, error) {
	out, err := runGh(ctx, dir, maxLabelBytes, "issue", "view", strconv.Itoa(number), "--json", "labels")
	if err != nil {
		return nil, err
	}
	var answer struct {
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
	}
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil, err
	}
	rtn := make([]string, 0, len(answer.Labels))
	for _, l := range answer.Labels {
		rtn = append(rtn, l.Name)
	}
	return rtn, nil
}

// readSmallJSON decodes a regular file no larger than max.
func readSmallJSON(path string, max int64, v any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return fmt.Errorf("not a small file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
