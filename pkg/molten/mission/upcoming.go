// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The Reviews view's upcoming work and the agents on each branch (#712, FR-REV-022, DS-REV-015). Upcoming: the ticket
// branches (workflow.branchNaming) with commits ahead of the PR target and no open PR yet, local or on origin. Agents:
// each running agent terminal placed in the worktree its folder belongs to, which names the branch it works on; a
// linked worktree on a ticket branch with recent activity and no agent terminal is reported as a background agent
// (an agent run inside another agent, a Claude Code worktree agent for instance), a heuristic the view says as
// "probably active". The answer is cached per project: the view asks on each of its own refreshes, never on a timer.

const (
	UpcomingCommand = "moltenmissionupcoming"

	UpcomingAgentPanel      = "panel"
	UpcomingAgentBackground = "background"

	upcomingMaxAge         = 20 * time.Second
	upcomingForcedInterval = 5 * time.Second
	upcomingTicketsMaxAge  = time.Minute
	upcomingGitTimeout     = 15 * time.Second
	upcomingGhTimeout      = 10 * time.Second
	// The newest candidate branches whose commits are counted; older ones are not listed.
	upcomingMaxBranches = 20
	// A linked worktree whose last commit or changed file is younger than this has a background agent, probably.
	BackgroundActivityWindow = 10 * time.Minute
	// The changed files of a worktree whose times are read, and the worktrees read, per answer.
	backgroundMaxFiles = 100
	backgroundMaxTrees = 12

	ticketStateClosed = "CLOSED"
	ticketStatusDone  = "done"
)

// The folder Claude Code puts its worktree agents in: a background agent there was started by a Claude Code session of
// the main checkout.
var claudeWorktreesDir = filepath.Join(".claude", "worktrees")

var ticketStatusNameRe = regexp.MustCompile(`^[\p{L}\p{N} _-]{1,40}$`)

type UpcomingRequest struct {
	Dir   string `json:"dir"`
	Force bool   `json:"force,omitempty"`
}

type UpcomingBranch struct {
	Branch string `json:"branch"`
	Ticket int    `json:"ticket"`
	// Commits ahead of the PR target.
	Ahead int `json:"ahead"`
	// Remote: only on origin, no local branch.
	Remote   bool   `json:"remote,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	// The branch's last commit, in Unix milliseconds.
	CommitAt int64  `json:"commitat,omitempty"`
	Title    string `json:"title,omitempty"`
	Url      string `json:"url,omitempty"`
	// The ticket's board Status as named on the board, "" when unknown (no project scope, not on a board).
	Status string `json:"status,omitempty"`
}

// BranchAgent is an agent working on a branch: a terminal's (Kind panel, BlockId set) or, probably, a background one.
type BranchAgent struct {
	Branch    string `json:"branch"`
	Worktree  string `json:"worktree"`
	Kind      string `json:"kind"`
	BlockId   string `json:"blockid,omitempty"`
	Agent     string `json:"agent,omitempty"`
	FirstName string `json:"firstname,omitempty"`
	// Started: the agent run's start (panel), in Unix milliseconds.
	Started int64 `json:"started,omitempty"`
	// ActiveAt: a background agent's last sign of activity, in Unix milliseconds.
	ActiveAt int64 `json:"activeat,omitempty"`
	// ParentBlockId: the panel agent that probably started a background agent, when one stands out.
	ParentBlockId   string `json:"parentblockid,omitempty"`
	ParentFirstName string `json:"parentfirstname,omitempty"`
}

type UpcomingAnswer struct {
	Dir          string           `json:"dir"`
	Target       string           `json:"target,omitempty"`
	Branches     []UpcomingBranch `json:"branches"`
	Agents       []BranchAgent    `json:"agents"`
	Error        string           `json:"error,omitempty"`
	ErrorText    *uimsg.Text      `json:"errortext,omitempty"`
	TicketsError string           `json:"ticketserror,omitempty"`
	At           int64            `json:"at"`
}

// AgentPlace is a running agent terminal and where it works.
type AgentPlace struct {
	BlockId   string
	Agent     string
	FirstName string
	Started   int64
	// Cwd: the terminal's local folder; Link: the worktree MoltenTerm linked it to (molten:worktree).
	Cwd  string
	Link string
	// Review: a review session's terminal, read-only, never the one working on the branch.
	Review bool
}

type upcomingTicket struct {
	Title  string
	Url    string
	Closed bool
	Status string
}

// UpcomingEnv is what the upcoming work reads outside git; the tests give fakes.
type UpcomingEnv struct {
	Run      Runner
	Now      func() time.Time
	Snapshot func(dir string) (Snapshot, bool)
	Agents   func(ctx context.Context) []AgentPlace
	// FileTime: a file's modification time, in Unix milliseconds (0 when it cannot be read).
	FileTime func(path string) int64
}

type upcomingState struct {
	answer    UpcomingAnswer
	at        time.Time
	ticketKey string
	ticketsAt time.Time
	tickets   map[int]upcomingTicket
	ticketErr string
}

type Upcoming struct {
	env    UpcomingEnv
	lock   sync.Mutex
	states map[string]*upcomingState
	// One computation per project at a time.
	running map[string]*sync.Mutex
}

func MakeUpcoming(env UpcomingEnv) *Upcoming {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.FileTime == nil {
		env.FileTime = fileTimeMs
	}
	return &Upcoming{env: env, states: map[string]*upcomingState{}, running: map[string]*sync.Mutex{}}
}

func fileTimeMs(path string) int64 {
	info, err := os.Lstat(path)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

func (u *Upcoming) projectLock(dir string) *sync.Mutex {
	u.lock.Lock()
	defer u.lock.Unlock()
	m := u.running[dir]
	if m == nil {
		m = &sync.Mutex{}
		u.running[dir] = m
	}
	return m
}

// cached answers with a fresh enough answer, or nil when one is due.
func (u *Upcoming) cached(dir string, force bool) *UpcomingAnswer {
	u.lock.Lock()
	defer u.lock.Unlock()
	state := u.states[dir]
	if state == nil || state.at.IsZero() {
		return nil
	}
	age := u.env.Now().Sub(state.at)
	if age < upcomingMaxAge && (!force || age < upcomingForcedInterval) {
		answer := state.answer
		return &answer
	}
	return nil
}

func (u *Upcoming) stateOf(dir string) *upcomingState {
	u.lock.Lock()
	defer u.lock.Unlock()
	state := u.states[dir]
	if state == nil {
		if len(u.states) >= maxProjects {
			u.states = map[string]*upcomingState{}
		}
		state = &upcomingState{}
		u.states[dir] = state
	}
	return state
}

func (u *Upcoming) store(dir string, answer UpcomingAnswer) {
	u.lock.Lock()
	defer u.lock.Unlock()
	if state := u.states[dir]; state != nil {
		state.answer = answer
		state.at = u.env.Now()
	}
}

// Get answers with the project's upcoming branches and the agents on its branches.
func (u *Upcoming) Get(req UpcomingRequest) (UpcomingAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return UpcomingAnswer{}, err
	}
	dir := filepath.Clean(req.Dir)
	if answer := u.cached(dir, req.Force); answer != nil {
		return *answer, nil
	}
	m := u.projectLock(dir)
	m.Lock()
	defer m.Unlock()
	if answer := u.cached(dir, req.Force); answer != nil {
		return *answer, nil
	}
	answer := u.compute(dir)
	u.store(dir, answer)
	return answer, nil
}

func (u *Upcoming) compute(dir string) UpcomingAnswer {
	answer := UpcomingAnswer{Dir: dir, Branches: []UpcomingBranch{}, Agents: []BranchAgent{}, At: u.env.Now().UnixMilli()}
	var snap Snapshot
	ok := false
	if u.env.Snapshot != nil {
		snap, ok = u.env.Snapshot(dir)
	}
	if !ok {
		snap = Snapshot{Dir: dir}
	}
	answer.Target, _ = reviewTarget(snap)
	ctx, cancel := context.WithTimeout(context.Background(), upcomingGitTimeout)
	defer cancel()
	g := &gitReader{ctx: ctx, run: u.env.Run, dir: dir}
	trees, err := listTrees(g)
	if err != nil {
		answer.Error = err.Error()
		answer.ErrorText = uimsg.TextOf(err)
		return answer
	}
	ticketRes := branchTicketRes(readBranchNaming(dir))
	var places []AgentPlace
	if u.env.Agents != nil {
		places = u.env.Agents(ctx)
	}
	answer.Agents = MatchBranchAgents(trees, places)
	answer.Agents = append(answer.Agents, u.backgroundAgents(ctx, trees, answer.Agents, places, ticketRes)...)
	refs := parseBranchRefs(g.lines("for-each-ref", "--format=%(refname)%00%(committerdate:unix)", "refs/heads", "refs/remotes/origin"))
	heads, known := openPrHeads(snap)
	if !known {
		// Without the open PRs every branch would look upcoming: say nothing rather than something wrong.
		return answer
	}
	candidates := UpcomingCandidates(refs, heads, ticketRes, answer.Target, trees, agentBranches(answer.Agents))
	targetRef := answer.Target
	if _, err := g.out("rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+answer.Target); err == nil {
		targetRef = "refs/remotes/origin/" + answer.Target
	}
	branches := make([]UpcomingBranch, 0, len(candidates))
	for _, c := range candidates {
		ref := "refs/heads/" + c.Branch
		if c.Remote {
			ref = "refs/remotes/origin/" + c.Branch
		}
		out, err := g.out("rev-list", "--count", targetRef+".."+ref)
		if err != nil {
			continue
		}
		c.Ahead, _ = strconv.Atoi(strings.TrimSpace(out))
		if c.Ahead == 0 && !agentBranches(answer.Agents)[c.Branch] {
			continue
		}
		branches = append(branches, c)
	}
	tickets, ticketErr := u.tickets(dir, snap, branches)
	answer.TicketsError = ticketErr
	answer.Branches = ApplyUpcomingTickets(branches, tickets)
	return answer
}

// tickets reads the candidate tickets' titles, states and board Status, at most once a minute for the same tickets.
func (u *Upcoming) tickets(dir string, snap Snapshot, branches []UpcomingBranch) (map[int]upcomingTicket, string) {
	numbers := map[int]bool{}
	for _, b := range branches {
		if b.Ticket > 0 {
			numbers[b.Ticket] = true
		}
	}
	gh := snap.Github
	if len(numbers) == 0 || gh == nil || gh.State != GithubStateOk || gh.Repo == "" {
		return nil, ""
	}
	sorted := make([]int, 0, len(numbers))
	for n := range numbers {
		sorted = append(sorted, n)
	}
	sort.Ints(sorted)
	repoRef := ghRepoRef(gh.Repo, gh.Url)
	key := fmt.Sprintf("%s:%v", repoRef, sorted)
	state := u.stateOf(dir)
	if tickets, errMsg, fresh := u.knownTickets(state, key); fresh {
		return tickets, errMsg
	}
	ctx, cancel := context.WithTimeout(context.Background(), upcomingGhTimeout)
	defer cancel()
	tickets, err := ReadUpcomingTickets(ctx, u.env.Run, dir, repoRef, sorted)
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	u.keepTickets(state, key, tickets, errMsg)
	return tickets, errMsg
}

func (u *Upcoming) knownTickets(state *upcomingState, key string) (map[int]upcomingTicket, string, bool) {
	u.lock.Lock()
	defer u.lock.Unlock()
	if state.ticketKey != key || u.env.Now().Sub(state.ticketsAt) >= upcomingTicketsMaxAge {
		return nil, "", false
	}
	return state.tickets, state.ticketErr, true
}

func (u *Upcoming) keepTickets(state *upcomingState, key string, tickets map[int]upcomingTicket, errMsg string) {
	u.lock.Lock()
	defer u.lock.Unlock()
	state.ticketKey, state.ticketsAt, state.tickets, state.ticketErr = key, u.env.Now(), tickets, errMsg
}

func listTrees(g *gitReader) ([]treeEntry, error) {
	out, err := g.out("worktree", "list", "--porcelain")
	if err != nil {
		return nil, uimsg.Errorf(uimsg.Make("mission.upcoming.noTrees"), "the project's worktrees could not be listed")
	}
	trees := parseTrees(out)
	for i := range trees {
		trees[i].path = realPath(trees[i].path)
	}
	return trees, nil
}

type treeEntry struct {
	path string
	// The short branch name, "" for a detached head.
	branch string
}

func parseTrees(out string) []treeEntry {
	var rtn []treeEntry
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			rtn = append(rtn, treeEntry{path: path})
			continue
		}
		if ref, ok := strings.CutPrefix(line, "branch refs/heads/"); ok && len(rtn) > 0 {
			rtn[len(rtn)-1].branch = ref
		}
	}
	return rtn
}

type branchRef struct {
	name     string
	remote   bool
	commitAt int64
}

func parseBranchRefs(lines []string) []branchRef {
	var rtn []branchRef
	for _, line := range lines {
		parts := strings.SplitN(line, "\x00", 2)
		if len(parts) != 2 {
			continue
		}
		at, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if name, ok := strings.CutPrefix(parts[0], "refs/heads/"); ok {
			rtn = append(rtn, branchRef{name: name, commitAt: at * 1000})
		} else if name, ok := strings.CutPrefix(parts[0], "refs/remotes/origin/"); ok && name != "HEAD" {
			rtn = append(rtn, branchRef{name: name, remote: true, commitAt: at * 1000})
		}
	}
	return rtn
}

// openPrHeads: the head branches of the repository's open PRs in the collector's snapshot, whatever their base; false
// when GitHub was not read (or the PRs could not be).
func openPrHeads(snap Snapshot) (map[string]bool, bool) {
	gh := snap.Github
	if gh == nil || gh.State != GithubStateOk || gh.Errors["prs"] != "" {
		return nil, false
	}
	var prs []ghReviewPr
	if len(gh.Prs) > 0 {
		if err := json.Unmarshal(gh.Prs, &prs); err != nil {
			return nil, false
		}
	}
	heads := map[string]bool{}
	for _, pr := range prs {
		if !pr.IsCrossRepository {
			heads[pr.HeadRefName] = true
		}
	}
	return heads, true
}

func agentBranches(agents []BranchAgent) map[string]bool {
	rtn := map[string]bool{}
	for _, a := range agents {
		rtn[a.Branch] = true
	}
	return rtn
}

// UpcomingCandidates are the ticket branches without an open PR, newest first: a local branch hides its origin twin,
// the target itself is never one. With agents, a branch an agent works on comes first, so the cap never drops it.
func UpcomingCandidates(refs []branchRef, prHeads map[string]bool, ticketRes []*regexp.Regexp, target string, trees []treeEntry, withAgent map[string]bool) []UpcomingBranch {
	byName := map[string]UpcomingBranch{}
	for _, ref := range refs {
		if ref.name == target || prHeads[ref.name] {
			continue
		}
		ticket := ticketOfBranch(ref.name, ticketRes)
		if ticket == 0 {
			continue
		}
		if have, ok := byName[ref.name]; ok && !have.Remote {
			continue
		}
		byName[ref.name] = UpcomingBranch{Branch: ref.name, Ticket: ticket, Remote: ref.remote, CommitAt: ref.commitAt}
	}
	for i, tree := range trees {
		if c, ok := byName[tree.branch]; ok && i > 0 {
			c.Worktree = tree.path
			byName[tree.branch] = c
		}
	}
	rtn := make([]UpcomingBranch, 0, len(byName))
	for _, c := range byName {
		rtn = append(rtn, c)
	}
	sort.Slice(rtn, func(i, j int) bool {
		a, b := rtn[i], rtn[j]
		if withAgent[a.Branch] != withAgent[b.Branch] {
			return withAgent[a.Branch]
		}
		if a.CommitAt != b.CommitAt {
			return a.CommitAt > b.CommitAt
		}
		return a.Branch < b.Branch
	})
	if len(rtn) > upcomingMaxBranches {
		rtn = rtn[:upcomingMaxBranches]
	}
	return rtn
}

// ApplyUpcomingTickets names each branch's ticket and drops the branches whose ticket is closed or Done: their work
// is over even if the branch was never deleted. Without ticket facts the branch stays.
func ApplyUpcomingTickets(branches []UpcomingBranch, tickets map[int]upcomingTicket) []UpcomingBranch {
	rtn := []UpcomingBranch{}
	for _, b := range branches {
		ticket, ok := tickets[b.Ticket]
		if ok {
			if ticket.Closed || strings.EqualFold(ticket.Status, ticketStatusDone) {
				continue
			}
			b.Title, b.Url, b.Status = ticket.Title, ticket.Url, ticket.Status
		}
		rtn = append(rtn, b)
	}
	return rtn
}

// treeOf is the deepest worktree holding the path ("" when none does): a linked worktree inside the main checkout
// (.claude/worktrees) wins over the main checkout.
func treeOf(trees []treeEntry, path string) (treeEntry, bool) {
	best, found := treeEntry{}, false
	for _, tree := range trees {
		if !pathInside(path, tree.path) {
			continue
		}
		if !found || len(tree.path) > len(best.path) {
			best, found = tree, true
		}
	}
	return best, found
}

func placePath(p AgentPlace) string {
	if p.Link != "" {
		return filepath.Clean(p.Link)
	}
	if filepath.IsAbs(p.Cwd) {
		return filepath.Clean(p.Cwd)
	}
	return ""
}

// MatchBranchAgents places each running agent terminal in its worktree and so on that worktree's branch. Review
// session terminals and detached worktrees name no branch an agent works on. The paths are compared as given: the
// live layer resolves symlinks before.
func MatchBranchAgents(trees []treeEntry, places []AgentPlace) []BranchAgent {
	rtn := []BranchAgent{}
	for _, p := range places {
		path := placePath(p)
		if p.Review || path == "" {
			continue
		}
		tree, ok := treeOf(trees, path)
		if !ok || tree.branch == "" {
			continue
		}
		rtn = append(rtn, BranchAgent{
			Branch: tree.branch, Worktree: tree.path, Kind: UpcomingAgentPanel, BlockId: p.BlockId, Agent: p.Agent,
			FirstName: p.FirstName, Started: p.Started,
		})
	}
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].Started < rtn[j].Started })
	return rtn
}

// treeActivity: the newest of the worktree's last commit and its changed files' times, in Unix milliseconds.
func (u *Upcoming) treeActivity(ctx context.Context, tree string) int64 {
	g := &gitReader{ctx: ctx, run: u.env.Run, dir: tree}
	var newest int64
	if out, err := g.out("log", "-1", "--format=%ct"); err == nil {
		if at, err := strconv.ParseInt(strings.TrimSpace(out), 10, 64); err == nil {
			newest = at * 1000
		}
	}
	out, err := g.out("status", "--porcelain=v2", "--untracked-files=all", "-z")
	if err != nil {
		return newest
	}
	read := 0
	for _, entry := range strings.Split(out, "\x00") {
		if entry == "" || read >= backgroundMaxFiles {
			continue
		}
		if !(strings.HasPrefix(entry, "1 ") || strings.HasPrefix(entry, "2 ") || strings.HasPrefix(entry, "? ") || strings.HasPrefix(entry, "u ")) {
			continue
		}
		read++
		if at := u.env.FileTime(filepath.Join(tree, changePath(entry))); at > newest {
			newest = at
		}
	}
	return newest
}

func (u *Upcoming) backgroundAgents(ctx context.Context, trees []treeEntry, panels []BranchAgent, places []AgentPlace, ticketRes []*regexp.Regexp) []BranchAgent {
	if len(trees) < 2 {
		return nil
	}
	busy := map[string]bool{}
	for _, a := range panels {
		busy[a.Worktree] = true
	}
	activity := map[string]int64{}
	read := 0
	for _, tree := range trees[1:] {
		if busy[tree.path] || tree.branch == "" || ticketOfBranch(tree.branch, ticketRes) == 0 || read >= backgroundMaxTrees {
			continue
		}
		read++
		activity[tree.path] = u.treeActivity(ctx, tree.path)
	}
	return BackgroundAgents(trees, panels, places, activity, u.env.Now())
}

// BackgroundAgents reports the linked worktrees without an agent terminal whose activity is recent. The parent is the
// one Claude Code terminal working in the main checkout when the worktree is a Claude Code worktree agent's.
func BackgroundAgents(trees []treeEntry, panels []BranchAgent, places []AgentPlace, activity map[string]int64, now time.Time) []BranchAgent {
	if len(trees) < 2 {
		return nil
	}
	main := trees[0]
	var parents []AgentPlace
	for _, p := range places {
		path := placePath(p)
		if p.Review || p.Agent != molten.AgentIdClaude || path == "" {
			continue
		}
		if tree, ok := treeOf(trees, path); ok && tree.path == main.path {
			parents = append(parents, p)
		}
	}
	busy := map[string]bool{}
	for _, a := range panels {
		busy[a.Worktree] = true
	}
	since := now.Add(-BackgroundActivityWindow).UnixMilli()
	var rtn []BranchAgent
	for _, tree := range trees[1:] {
		at, ok := activity[tree.path]
		if !ok || busy[tree.path] || at < since {
			continue
		}
		agent := BranchAgent{Branch: tree.branch, Worktree: tree.path, Kind: UpcomingAgentBackground, ActiveAt: at}
		if pathInside(tree.path, filepath.Join(main.path, claudeWorktreesDir)) {
			agent.Agent = molten.AgentIdClaude
			if len(parents) == 1 {
				agent.ParentBlockId, agent.ParentFirstName = parents[0].BlockId, parents[0].FirstName
			}
		}
		rtn = append(rtn, agent)
	}
	return rtn
}

type ghUpcomingIssue struct {
	Title        string `json:"title"`
	Url          string `json:"url"`
	State        string `json:"state"`
	ProjectItems *struct {
		Nodes []struct {
			Status *struct {
				Name string `json:"name"`
			} `json:"status"`
		} `json:"nodes"`
	} `json:"projectItems"`
}

// upcomingTicketsQuery reads the tickets' titles and states, with their board Status when withStatus. Numbers are
// integers formatted here, never text from GitHub.
func upcomingTicketsQuery(numbers []int, withStatus bool) string {
	var sb strings.Builder
	sb.WriteString("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){")
	for _, n := range numbers {
		fmt.Fprintf(&sb, "t%d:issue(number:%d){title url state", n, n)
		if withStatus {
			sb.WriteString(" projectItems(first:5){nodes{status:fieldValueByName(name:\"Status\"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}")
		}
		sb.WriteString("}")
	}
	sb.WriteString("}}")
	return sb.String()
}

// ReadUpcomingTickets asks GitHub, through the developer's gh, for the tickets' titles, states and board Status. A
// token without the project scope fails the Status part: the tickets are read again without it.
func ReadUpcomingTickets(ctx context.Context, run Runner, dir string, repoRef string, numbers []int) (map[int]upcomingTicket, error) {
	parts := strings.Split(repoRef, "/")
	if len(parts) < 2 {
		return nil, fmt.Errorf("no repository to read the tickets from")
	}
	tickets, err := readUpcomingTickets(ctx, run, dir, parts, numbers, true)
	if err == nil {
		return tickets, nil
	}
	return readUpcomingTickets(ctx, run, dir, parts, numbers, false)
}

func readUpcomingTickets(ctx context.Context, run Runner, dir string, parts []string, numbers []int, withStatus bool) (map[int]upcomingTicket, error) {
	owner, name := parts[len(parts)-2], parts[len(parts)-1]
	args := []string{"api", "graphql", "-f", "query=" + upcomingTicketsQuery(numbers, withStatus), "-f", "owner=" + owner, "-f", "name=" + name}
	if len(parts) == 3 {
		args = append(args, "--hostname", parts[0])
	}
	out, err := run(ctx, dir, "gh", args...)
	var answer struct {
		Data struct {
			Repository map[string]*ghUpcomingIssue `json:"repository"`
		} `json:"data"`
		Errors []struct {
			Type string `json:"type"`
		} `json:"errors"`
	}
	if jsonErr := json.Unmarshal(out, &answer); jsonErr != nil || answer.Data.Repository == nil {
		if err != nil {
			return nil, fmt.Errorf("%s", shortGhError(err))
		}
		return nil, fmt.Errorf("gh api graphql: unreadable answer")
	}
	for _, e := range answer.Errors {
		if withStatus && e.Type == "INSUFFICIENT_SCOPES" {
			return nil, fmt.Errorf("gh api graphql: the token cannot read the board")
		}
	}
	rtn := map[int]upcomingTicket{}
	for _, n := range numbers {
		node := answer.Data.Repository[fmt.Sprintf("t%d", n)]
		if node == nil {
			continue
		}
		ticket := upcomingTicket{Title: node.Title, Url: node.Url, Closed: strings.EqualFold(node.State, ticketStateClosed)}
		if node.ProjectItems != nil {
			for _, item := range node.ProjectItems.Nodes {
				if item.Status != nil && ticketStatusNameRe.MatchString(item.Status.Name) {
					ticket.Status = item.Status.Name
					break
				}
			}
		}
		rtn[n] = ticket
	}
	return rtn, nil
}
