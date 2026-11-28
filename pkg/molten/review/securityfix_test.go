// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The fix of a shared security block (FR-REV-036 AC9 to AC14, #2589). Every test works on a real git repository with its
// remote, and fakes everything else: GitHub (the developer's gh), the ticket tool, the terminals, the agents and the
// clock. Nothing creates a real issue or starts a real agent.

const securityTrunk = "develop"

// securityFixture is a restart fixture with the security fix's seams faked.
type securityFixture struct {
	*restartFixture
	store *secfix.FixStore

	lock sync.Mutex
	// What the fakes answer.
	result     secfix.Result
	haveResult bool
	consent    string
	issueFound string
	prFound    string
	headPrs    string
	prView     string
	checks     string
	milestones []string
	loaded     bool
	working    int
	nowMs      int64
	createErr  error
	// What the fakes saw.
	ghCalls     []string
	issues      int
	ticketRuns  [][]string
	terminals   []string
	terminalMap []waveobj.MetaMapType
	tabs        []agentTabCall
	notices     []molten.NotificationInput
	resolvedKey []string
	stopped     []string
	readied     int
	// opened: told once for each terminal opened; noted: once for each notification, which a launch makes last. The tests
	// that wait for a launch the consent started wait on them, never on the clock.
	opened chan string
	noted  chan molten.NotificationInput
}

func makeSecurityFixture(t *testing.T) *securityFixture {
	rf := makeRestartFixture(t)
	f := &securityFixture{restartFixture: rf, store: secfix.MakeFixStore(filepath.Join(rf.dataDir, "security-fixes.json")),
		consent: secfix.ConsentOn, issueFound: "[]", prFound: "[]", headPrs: "[]", milestones: []string{"1.1.0", "1.0.0", "Later"},
		nowMs: 1_000_000, opened: make(chan string, 16), noted: make(chan molten.NotificationInput, 16)}
	f.store.UseClock(func() time.Time { return f.now() })
	env := &rf.r.env
	env.Now = f.now
	env.Gh = f.gh
	env.OpenTerminal = func(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType, line string) (string, error) {
		f.lock.Lock()
		f.terminals = append(f.terminals, line)
		f.terminalMap = append(f.terminalMap, meta)
		f.lock.Unlock()
		f.opened <- line
		return "new-block", nil
	}
	env.AgentTab = func(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType, hidden bool) (string, error) {
		f.lock.Lock()
		defer f.lock.Unlock()
		f.tabs = append(f.tabs, agentTabCall{workspaceId: workspaceId, name: name, meta: meta, hidden: hidden})
		return "agent-tab", nil
	}
	env.Notify = func(ctx context.Context, input molten.NotificationInput) error {
		f.lock.Lock()
		f.notices = append(f.notices, input)
		f.lock.Unlock()
		select {
		case f.noted <- input:
		default:
		}
		return nil
	}
	env.ResolveNotices = func(ctx context.Context, prefix string) error {
		f.lock.Lock()
		defer f.lock.Unlock()
		f.resolvedKey = append(f.resolvedKey, prefix)
		return nil
	}
	env.SecurityFix = SecurityFixEnv{
		Store: func() *secfix.FixStore { return f.store },
		Result: func(dir string) (secfix.Result, bool) {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.result, f.haveResult
		},
		Consent: func() string {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.consent
		},
		Run: func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.ticketRuns = append(f.ticketRuns, append([]string{name}, args...))
			f.issues++
			return []byte(fmt.Sprintf("Creating issue...\nIssue URL: https://github.com/%s/issues/%d\n", restartRepo, 100+f.issues)), nil
		},
		ProjectWorkspace: func(ctx context.Context, dir string) string { return "ws-project" },
		AgentsWorking: func() int {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.working
		},
		MachineLoaded: func() bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.loaded
		},
		StopAgent: func(ctx context.Context, blockId string) (bool, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.stopped = append(f.stopped, blockId)
			return true, nil
		},
	}
	return f
}

func (f *securityFixture) now() time.Time {
	f.lock.Lock()
	defer f.lock.Unlock()
	return time.UnixMilli(f.nowMs)
}

func (f *securityFixture) advance(d time.Duration) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.nowMs += d.Milliseconds()
}

func (f *securityFixture) set(change func()) {
	f.lock.Lock()
	defer f.lock.Unlock()
	change()
}

func milestonesGraphql(titles []string) string {
	var nodes []string
	for i, title := range titles {
		nodes = append(nodes, fmt.Sprintf(`{"number":%d,"title":%q,"url":"https://github.com/acme/app/milestone/%d","dueOn":null,"open":{"totalCount":1},"closed":{"totalCount":0}}`, i+1, title, i+1))
	}
	return `{"data":{"repository":{"milestones":{"nodes":[` + strings.Join(nodes, ",") + `]}}}}`
}

// gh is the developer's gh as a fake: it reads what the tests set and refuses everything that could change GitHub but
// the calls a fix is allowed (a ticket, a comment on it, a pull request marked ready).
func (f *securityFixture) gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	call := strings.Join(args, " ")
	f.ghCalls = append(f.ghCalls, call)
	has := func(word string) bool { return strings.Contains(call, word) }
	switch {
	case (len(args) > 1 && args[0] == "pr" && args[1] == "merge") || has("/merge"):
		return nil, fmt.Errorf("MoltenTerm must never merge: %s", call)
	case strings.HasPrefix(call, "api graphql"):
		return []byte(milestonesGraphql(f.milestones)), nil
	case strings.HasPrefix(call, "pr list") && has("--search"):
		return []byte(f.prFound), nil
	case strings.HasPrefix(call, "pr list") && has("--head"):
		return []byte(f.headPrs), nil
	case strings.HasPrefix(call, "issue list"):
		return []byte(f.issueFound), nil
	case strings.HasPrefix(call, "issue create"):
		if f.createErr != nil {
			return nil, f.createErr
		}
		f.issues++
		return []byte(fmt.Sprintf("https://github.com/%s/issues/%d\n", restartRepo, 100+f.issues)), nil
	case strings.HasPrefix(call, "issue comment"):
		return nil, nil
	case strings.HasPrefix(call, "pr ready"):
		f.readied++
		return nil, nil
	case strings.HasPrefix(call, "pr view"):
		return []byte(f.prView), nil
	case strings.HasPrefix(call, "pr checks"):
		return []byte(f.checks), nil
	}
	return nil, fmt.Errorf("MoltenTerm must not %s", call)
}

func (f *securityFixture) calls(prefix string) []string {
	f.lock.Lock()
	defer f.lock.Unlock()
	var found []string
	for _, call := range f.ghCalls {
		if strings.HasPrefix(call, prefix) {
			found = append(found, call)
		}
	}
	return found
}

func (f *securityFixture) noticesSnapshot() []molten.NotificationInput {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]molten.NotificationInput{}, f.notices...)
}

func (f *securityFixture) terminalLines() []string {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]string{}, f.terminals...)
}

// A shared block of two advisories on pull requests 12 and 14 (and 9, the pull request of the restart fixture).
func securityBlock() secfix.Block {
	advisories := []secfix.Advisory{
		{Id: "GHSA-aaaa-bbbb-cccc", Package: "left-pad", Version: "1.0.0", Fixed: "1.0.1", Severity: "high", Summary: "A crafted string makes it loop"},
		{Id: "GO-2026-1", Package: "golang.org/x/crypto", Version: "0.58.0", Ecosystem: "go"},
	}
	check := "Dependency security / Scan dependencies"
	return secfix.Block{Fingerprint: secfix.Fingerprint(secfix.Ids(advisories)), Check: check, Origin: secfix.OriginDeclared, Source: secfix.SourceReport,
		Advisories: advisories, TrunkFailing: true, Shared: true,
		Prs: []secfix.BlockPr{
			{Number: 9, Checks: []string{check}, Shared: true, Reasons: []string{secfix.ReasonTrunk}},
			{Number: 12, Checks: []string{check}, Shared: true, Reasons: []string{secfix.ReasonTrunk}},
			{Number: 14, Checks: []string{check}, Shared: true, Reasons: []string{secfix.ReasonTrunk}},
		}}
}

func (f *securityFixture) seeBlock(block secfix.Block) {
	f.set(func() {
		f.result, f.haveResult = secfix.Result{Blocks: []secfix.Block{block}, Offers: []secfix.Offer{}, Unread: []secfix.Unread{}}, true
	})
}

func (f *securityFixture) request(block secfix.Block) SecurityFixRequest {
	return SecurityFixRequest{Dir: f.dir, Repo: restartRepo, Trunk: securityTrunk, Fingerprint: block.Fingerprint, WorkspaceId: "ws-1", TabName: "Security fix"}
}

func (f *securityFixture) ask(block secfix.Block) SecurityFixResult {
	f.t.Helper()
	f.seeBlock(block)
	res, err := f.r.AskSecurityFix(context.Background(), f.request(block))
	if err != nil {
		f.t.Fatalf("ask: %v", err)
	}
	return res
}

func (f *securityFixture) fix(block secfix.Block) secfix.Fix {
	f.t.Helper()
	fix, ok := f.store.Get(f.dir, block.Fingerprint)
	if !ok {
		f.t.Fatalf("no fix of %s: %+v", block.Fingerprint, f.store.List(f.dir))
	}
	return fix
}

func awaitSignal[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(time.Minute):
		t.Fatalf("%s did not happen", what)
		var zero T
		return zero
	}
}

// AC9, AC12: the click starts one agent, in the background, in a new copy of the trunk on a branch named for its ticket,
// with a ticket made for the set in the release being prepared; nothing is merged and the project's checkout stays put.
func TestAskSecurityFixStartsOneAgentInTheBackground(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	res := f.ask(block)
	if res.Status != RestartStarted || res.BlockId != "new-block" || !res.Hidden || res.Agent != molten.AgentIdClaude || res.Fix == nil {
		t.Fatalf("result: %+v", res)
	}
	creates := f.calls("issue create")
	if len(creates) != 1 {
		t.Fatalf("one ticket: %v", creates)
	}
	for _, part := range []string{"--repo " + restartRepo, "--title Dependency advisories: GHSA-aaaa-bbbb-cccc, GO-2026-1", "--milestone 1.0.0", "| GHSA-aaaa-bbbb-cccc | left-pad | 1.0.0 | 1.0.1 | high |",
		"Blocked pull requests: #9, #12, #14", "never merges the fix"} {
		if !strings.Contains(creates[0], part) {
			t.Errorf("the ticket misses %q: %s", part, creates[0])
		}
	}
	if res.Branch != "fix/101-ghsa-aaaa-bbbb-cccc-go-2026-1" {
		t.Errorf("branch %q", res.Branch)
	}
	if head := f.git(res.Worktree, "rev-parse", "--abbrev-ref", "HEAD"); head != res.Branch {
		t.Errorf("the copy is on %s, want the new branch %s", head, res.Branch)
	}
	if main := f.git(f.dir, "rev-parse", "--abbrev-ref", "HEAD"); main != securityTrunk {
		t.Errorf("the project's checkout moved to %s", main)
	}
	if tip, trunk := f.git(res.Worktree, "rev-parse", "HEAD"), f.git(f.dir, "rev-parse", "origin/"+securityTrunk); tip != trunk {
		t.Errorf("the copy starts at %s, not at origin/%s (%s)", tip, securityTrunk, trunk)
	}
	if want := filepath.Join(f.dataDir, "molten", "worktrees"); !strings.HasPrefix(res.Worktree, want) {
		t.Errorf("worktree %s, want it under %s", res.Worktree, want)
	}
	if len(f.tabs) != 1 || !f.tabs[0].hidden || f.tabs[0].workspaceId != "ws-1" || f.tabs[0].name != "Security fix" {
		t.Errorf("one hidden tab in the workspace the window named: %+v", f.tabs)
	}
	lines := f.terminalLines()
	if len(lines) != 1 {
		t.Fatalf("one terminal: %v", lines)
	}
	for _, part := range []string{"claude -- ", "security fix, ticket #101, advisories GHSA-aaaa-bbbb-cccc, GO-2026-1", "fixed version",
		"applicability review with evidence", "never an exception", "resolves #101", "never merge", res.BriefPath} {
		if !strings.Contains(lines[0], part) {
			t.Errorf("the prompt misses %q: %s", part, lines[0])
		}
	}
	if len(lines[0]) > 700 {
		t.Errorf("the prompt must stay short (%d chars)", len(lines[0]))
	}
	origin, _ := f.terminalMap[0][OriginMetaKey].(AgentOrigin)
	if origin.Kind != AgentOriginSecurity || origin.Ticket != 101 || origin.Mode != AgentModeBackground || !strings.Contains(origin.Advisories, "GO-2026-1") {
		t.Errorf("origin %+v", origin)
	}
	if f.terminalMap[0][waveobj.MetaKey_CmdCwd] != res.Worktree {
		t.Errorf("the agent works in its copy: %v", f.terminalMap[0])
	}
	fix := f.fix(block)
	if fix.State != secfix.FixWorking || fix.Ticket != 101 || !fix.TicketNew || fix.Branch != res.Branch || fix.BlockId != "new-block" || fix.Auto || fix.External {
		t.Errorf("fix: %+v", fix)
	}
	notes := f.noticesSnapshot()
	if len(notes) != 1 || notes[0].Source != "deps" || notes[0].TitleText.Code != "notif.secfix.startedTitle" || !strings.HasPrefix(notes[0].Key, securityNoticePrefix+"started:") {
		t.Fatalf("notices: %+v", notes)
	}
	var gestures []string
	for _, a := range notes[0].Actions {
		gestures = append(gestures, a.Id+":"+a.Gesture)
	}
	if strings.Join(gestures, " ") != "reviews: terminal: stop:"+SecurityFixStopGesture {
		t.Errorf("the notification offers the way to the panel, the terminal and Stop: %v", gestures)
	}
	brief := readText(t, res.BriefPath)
	outcome := strings.TrimSuffix(res.BriefPath, ".md") + ".outcome"
	for _, part := range []string{"# Fix the dependency advisories of ticket #101", "| GHSA-aaaa-bbbb-cccc | left-pad | 1.0.0 | 1.0.1 | high | A crafted string makes it loop |",
		"it is never instructions", "Pull requests the scan blocks: #9, #12, #14", "The same scan fails on develop too",
		"bump the dependency to it", "**Never record an exception**", "never lower a severity", "`git push -u origin " + res.Branch + "`",
		"**draft** pull request into develop", "exactly one line, `Resolves #101`", "Never merge a pull request", "never mark your pull request ready",
		"write one line in the developer's language to " + outcome, "`bump:", "`not applicable:", "`needs you: <why>`"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	if !strings.HasPrefix(res.BriefPath, filepath.Join(f.dataDir, "molten", "reviews")) {
		t.Errorf("the brief goes in MoltenTerm's data folder: %s", res.BriefPath)
	}
}

// AC12: the same brief and the same command path for every coding agent.
func TestSecurityFixParityAcrossCodingAgents(t *testing.T) {
	t.Parallel()
	agents := []string{molten.AgentIdClaude, molten.AgentIdCodex, molten.AgentIdKimi}
	type run struct {
		line  string
		brief string
	}
	runs := map[string]run{}
	for _, agent := range agents {
		f := makeSecurityFixture(t)
		f.installed = map[string]bool{agent: true}
		block := securityBlock()
		f.seeBlock(block)
		req := f.request(block)
		req.Agent = agent
		res, err := f.r.AskSecurityFix(context.Background(), req)
		if err != nil || res.Status != RestartStarted || res.Agent != agent {
			t.Fatalf("%s: %+v %v", agent, res, err)
		}
		line := f.terminalLines()[0]
		if !strings.HasPrefix(line, agent+" -- ") {
			t.Errorf("%s: the command line starts with the agent's own program: %s", agent, line)
		}
		normalize := func(text string) string {
			text = strings.ReplaceAll(text, res.BriefPath, "<brief>")
			text = strings.ReplaceAll(text, strings.TrimSuffix(res.BriefPath, ".md"), "<brief>")
			text = strings.ReplaceAll(text, res.Worktree, "<tree>")
			text = strings.ReplaceAll(text, f.dir, "<project>")
			text = strings.ReplaceAll(text, f.dataDir, "<data>")
			return text
		}
		runs[agent] = run{line: strings.TrimPrefix(normalize(line), agent+" -- "), brief: normalize(readText(t, res.BriefPath))}
	}
	base := runs[molten.AgentIdClaude]
	for _, agent := range agents[1:] {
		if runs[agent].line != base.line {
			t.Errorf("%s's prompt differs from Claude Code's:\n%s\n%s", agent, runs[agent].line, base.line)
		}
		if runs[agent].brief != base.brief {
			t.Errorf("%s's brief differs from Claude Code's", agent)
		}
	}
}

// AC12: in a SaaSFoundry project the ticket is made through its ticket tool, as committed on the trunk, and the brief
// sends the agent through the project's workflow; elsewhere (above) a plain issue and the project's commit format.
func TestSecurityFixInASaaSFoundryProject(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	f.write(f.dir, ".saasfoundry.json", `{"workflow":{"tool":"github-projects","projectUrl":"https://github.com/orgs/acme/projects/1","branchNaming":{"fix":"fix/{N}-{description}"}},"tools":{"srs":{"backend":"notion"}}}`)
	f.write(f.dir, ".claude/skills/sf-tool-github-projects/github-projects-cli.sh", "#!/bin/sh\necho reviewed\n")
	f.git(f.dir, "add", "-A")
	f.git(f.dir, "commit", "--quiet", "-m", "chore: sf")
	f.git(f.dir, "push", "--quiet", "origin", securityTrunk)
	f.conv = &molten.ProjectConventions{BranchNaming: map[string]string{"fix": "fix/{N}-{description}"}, CommitPattern: "type(#N): description"}
	block := securityBlock()
	res := f.ask(block)
	if res.Status != RestartStarted {
		t.Fatalf("result: %+v", res)
	}
	if len(f.calls("issue create")) != 0 {
		t.Errorf("the project's ticket tool makes the ticket, not a plain issue: %v", f.calls("issue create"))
	}
	if len(f.ticketRuns) != 1 || f.ticketRuns[0][0] != "bash" {
		t.Fatalf("the ticket tool runs once: %v", f.ticketRuns)
	}
	args := strings.Join(f.ticketRuns[0][1:], " ")
	for _, part := range []string{"create-ticket issue Dependency advisories: GHSA-aaaa-bbbb-cccc, GO-2026-1 --body-file ", "--complexity low", "--milestone 1.0.0",
		"--bypass-srs dependency advisories, no user-facing change"} {
		if !strings.Contains(args, part) {
			t.Errorf("the ticket tool call misses %q: %s", part, args)
		}
	}
	if strings.Contains(args, "--nature") {
		t.Errorf("the nature is the developer's to label: %s", args)
	}
	brief := readText(t, res.BriefPath)
	for _, part := range []string{"This is a SaaSFoundry project: follow its AGENTS.md and its workflow skill from In progress to the end of AI Testing, for ticket #101",
		"never run `ready-pr`", "never record the delegation consent", "never set an escape hatch"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	if strings.Contains(brief, "gh pr create") {
		t.Errorf("a SaaSFoundry project opens its pull request through its workflow:\n%s", brief)
	}
}

// AC9: an open ticket that cites an advisory is the ticket, and an open pull request that cites one is a fix already on its
// way: MoltenTerm makes no second ticket and starts no agent beside it. The pull requests the scan blocks are not that.
func TestSecurityFixReusesWhatAlreadyCitesTheAdvisories(t *testing.T) {
	t.Parallel()
	block := securityBlock()

	f := makeSecurityFixture(t)
	f.set(func() {
		f.issueFound = `[{"number":88,"url":"https://github.com/acme/app/issues/88","title":"GHSA-aaaa-bbbb-cccc in left-pad"}]`
	})
	res := f.ask(block)
	if res.Status != RestartStarted || len(f.calls("issue create")) != 0 || len(f.ticketRuns) != 0 {
		t.Fatalf("an open ticket is reused: %+v, created %v", res, f.calls("issue create"))
	}
	if fix := f.fix(block); fix.Ticket != 88 || fix.TicketNew || res.Branch != "fix/88-ghsa-aaaa-bbbb-cccc-go-2026-1" {
		t.Errorf("fix %+v, branch %s", fix, res.Branch)
	}

	f = makeSecurityFixture(t)
	f.set(func() {
		f.prFound = `[{"number":12,"url":"https://github.com/acme/app/pull/12","title":"blocked by GHSA-aaaa-bbbb-cccc","headRefName":"feature/12-x","isDraft":false}]`
	})
	res = f.ask(block)
	if res.Status != RestartStarted || len(f.terminalLines()) != 1 {
		t.Fatalf("a pull request the scan blocks is not a fix: %+v", res)
	}

	f = makeSecurityFixture(t)
	f.set(func() {
		f.prFound = `[{"number":90,"url":"https://github.com/acme/app/pull/90","title":"Bump left-pad","headRefName":"fix/90-left-pad","isDraft":true}]`
	})
	res = f.ask(block)
	if res.Status != SecurityFixExternal || len(f.terminalLines()) != 0 || len(f.calls("issue create")) != 0 || len(f.tabs) != 0 {
		t.Fatalf("a pull request that cites the advisories is a fix on its way: %+v", res)
	}
	fix := f.fix(block)
	if !fix.External || fix.Pr != 90 || fix.Branch != "fix/90-left-pad" || fix.State != secfix.FixWorking {
		t.Errorf("fix %+v", fix)
	}
}

// AC9, AC11: the same set on several pull requests, read by concurrent refreshes, is one ticket and one agent.
func TestSecurityFixIsOneTicketAndOneAgentUnderConcurrentRefreshes(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.seeBlock(block)
	statuses := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := f.r.launchSecurityFix(context.Background(), securityLaunch{dir: f.dir, repo: restartRepo, trunk: securityTrunk, workspaceId: "ws-1", block: block, auto: true})
			statuses <- res.Status
		}()
	}
	wg.Wait()
	close(statuses)
	started := 0
	for status := range statuses {
		if status == RestartStarted {
			started++
		} else if status != RestartBusy && status != SecurityFixCovered {
			t.Errorf("a refresh answered %q", status)
		}
	}
	if started != 1 || len(f.calls("issue create")) != 1 || len(f.terminalLines()) != 1 || len(f.store.List(f.dir)) != 1 {
		t.Fatalf("started %d, tickets %d, terminals %d, fixes %d: want one of each", started, len(f.calls("issue create")), len(f.terminalLines()), len(f.store.List(f.dir)))
	}
}

// AC10: without the consent nothing starts on its own; with it, a shared block of a declared or confirmed scan does, and
// only that.
func TestSecurityFixStartsOnItsOwnOnlyWithTheConsent(t *testing.T) {
	t.Parallel()
	block := securityBlock()
	assessed := func(blocks ...secfix.Block) mission.SecurityAssessed {
		return mission.SecurityAssessed{Dir: "", Repo: restartRepo, Trunk: securityTrunk, Result: secfix.Result{Blocks: blocks}}
	}
	for _, consent := range []string{secfix.ConsentUnasked, secfix.ConsentOff} {
		f := makeSecurityFixture(t)
		f.set(func() { f.consent = consent })
		a := assessed(block)
		a.Dir = f.dir
		f.r.securityAssessed(a)
		if len(f.terminalLines()) != 0 || len(f.store.List(f.dir)) != 0 || len(f.ghCalls) != 0 {
			t.Fatalf("consent %s: nothing starts, nothing is read: terminals %v, fixes %v, gh %v", consent, f.terminalLines(), f.store.List(f.dir), f.ghCalls)
		}
	}

	f := makeSecurityFixture(t)
	notShared, guessed := securityBlock(), securityBlock()
	notShared.Shared, notShared.Fingerprint = false, "ffffffffffffffff"
	guessed.Origin, guessed.Fingerprint = "", "eeeeeeeeeeeeeeee"
	a := assessed(notShared, guessed, block)
	a.Dir = f.dir
	f.r.securityAssessed(a)
	line := awaitSignal(t, f.opened, "the launch the consent started")
	if !strings.HasPrefix(line, "claude -- ") {
		t.Errorf("line %s", line)
	}
	// The notification is the launch's last step.
	started := awaitSignal(t, f.noted, "the notification of the launch")
	if started.MessageText.Code != "notif.secfix.startedAuto" {
		t.Errorf("the notification says it started on its own: %+v", started)
	}
	fixes := f.store.List(f.dir)
	if len(fixes) != 1 || fixes[0].Fingerprint != block.Fingerprint || !fixes[0].Auto || fixes[0].WorkspaceId != "ws-project" {
		t.Fatalf("one fix, for the shared declared block, started on its own, in the project's workspace: %+v", fixes)
	}
	if brief := readText(t, f.r.securityBriefPath(restartRepo, block.Fingerprint)); !strings.Contains(brief, "under the developer's standing consent") {
		t.Errorf("the brief says why the agent started:\n%s", brief)
	}
}

// AC11: a fix the developer stopped, or that failed, is never started again on its own for the same advisories; the
// developer's click starts it again.
func TestSecurityFixIsNeverRelaunchedOnItsOwnAfterAStop(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	res := f.ask(block)
	if res.Status != RestartStarted {
		t.Fatalf("result: %+v", res)
	}
	stopped, err := f.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: f.dir, Fingerprint: block.Fingerprint})
	if err != nil || stopped.Status != SecurityFixStoppedStatus || stopped.Fix.State != secfix.FixStopped {
		t.Fatalf("stop: %+v %v", stopped, err)
	}
	f.advance(time.Hour)
	auto := f.r.launchSecurityFix(context.Background(), securityLaunch{dir: f.dir, repo: restartRepo, trunk: securityTrunk, workspaceId: "ws-1", block: block, auto: true})
	if auto.Status != SecurityFixHeld || len(f.terminalLines()) != 1 {
		t.Fatalf("a stopped fix is held: %+v, terminals %v", auto, f.terminalLines())
	}
	// What the consent runs, synchronously: the same loop over the assessment's blocks.
	f.r.launchAssessed(mission.SecurityAssessed{Dir: f.dir, Repo: restartRepo, Trunk: securityTrunk, Result: secfix.Result{Blocks: []secfix.Block{block}}})
	if len(f.terminalLines()) != 1 || f.fix(block).State != secfix.FixStopped {
		t.Fatalf("the consent never relaunches a stopped fix: %v", f.terminalLines())
	}
	again := f.ask(block)
	if again.Status != RestartStarted || len(f.terminalLines()) != 2 || f.fix(block).State != secfix.FixWorking {
		t.Fatalf("the developer's click starts it again: %+v", again)
	}
}

// AC11: the launch waits, and says why, while the computer is loaded or the agents fill their places; it never makes
// another one leave, and starts by itself once there is room.
func TestSecurityFixWaitsForAPlace(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.set(func() { f.loaded = true })
	res := f.ask(block)
	fix := f.fix(block)
	if res.Status != SecurityFixWaiting || fix.State != secfix.FixWaiting || fix.Reason != secfix.ReasonMachineBusy || fix.RetryAt <= f.now().UnixMilli() {
		t.Fatalf("a loaded machine waits: %+v %+v", res, fix)
	}
	if len(f.ghCalls) != 0 || len(f.terminalLines()) != 0 || len(f.tabs) != 0 {
		t.Fatalf("nothing is made while it waits: gh %v, terminals %v", f.ghCalls, f.terminalLines())
	}
	st := &securityFollowState{}
	f.r.securityFollowStep(context.Background(), f.dir, block.Fingerprint, st)
	if len(f.terminalLines()) != 0 {
		t.Fatal("it does not retry before its time")
	}
	f.set(func() { f.loaded, f.working = false, securityAgentCap })
	f.advance(securityRetryAfter + time.Second)
	f.r.securityFollowStep(context.Background(), f.dir, block.Fingerprint, st)
	if fix = f.fix(block); fix.State != secfix.FixWaiting || fix.Reason != secfix.ReasonAgentLimit {
		t.Fatalf("the agents fill their places: %+v", fix)
	}
	f.set(func() { f.working = securityAgentCap - 1 })
	f.advance(securityRetryAfter + time.Second)
	f.r.securityFollowStep(context.Background(), f.dir, block.Fingerprint, st)
	if fix = f.fix(block); fix.State != secfix.FixWorking || len(f.terminalLines()) != 1 || fix.WorkspaceId != "ws-1" {
		t.Fatalf("a place came: %+v, terminals %v", fix, f.terminalLines())
	}
}

func TestSecurityFixWithoutAnAgentRecordsNothing(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	f.installed = map[string]bool{}
	block := securityBlock()
	res := f.ask(block)
	if res.Status != RestartNoAgent || len(f.store.List(f.dir)) != 0 || len(f.ghCalls) != 0 || len(f.terminalLines()) != 0 {
		t.Fatalf("no agent, nothing: %+v, fixes %v, gh %v", res, f.store.List(f.dir), f.ghCalls)
	}
	f.installed = map[string]bool{molten.AgentIdClaude: true}
	f.codingAgent("codex")
	res = f.ask(block)
	if res.Status != RestartNoAgent || res.Reason != RestartReasonAgentMissing || !res.AgentMissing {
		t.Fatalf("a chosen agent that is not installed is named, never replaced: %+v", res)
	}
}

// codingAgent: the developer chose an agent for every project.
func (f *securityFixture) codingAgent(id string) {
	f.r.env.GlobalAgent = func() string { return id }
}

// AC9: a launch that fails before an agent is there keeps its claim, waits, and is tried again; after three tries it is
// failed (never started again on its own) and the developer is told.
func TestSecurityFixThatCannotStartIsFailedAfterThreeTries(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.set(func() { f.createErr = fmt.Errorf("gh: HTTP 502") })
	f.ask(block)
	st := &securityFollowState{}
	if fix := f.fix(block); fix.State != secfix.FixWaiting || fix.Reason != secfix.ReasonLaunchFailed || fix.Tries != 1 {
		t.Fatalf("first try: %+v", fix)
	}
	for try := 2; try <= securityMaxTries; try++ {
		f.advance(securityRetryAfter + time.Second)
		f.r.securityFollowStep(context.Background(), f.dir, block.Fingerprint, st)
	}
	fix := f.fix(block)
	if fix.State != secfix.FixFailed || fix.Reason != secfix.ReasonLaunchFailed {
		t.Fatalf("after three tries: %+v", fix)
	}
	notes := f.noticesSnapshot()
	if len(notes) != 1 || notes[0].Kind != "warning" || !strings.Contains(notes[0].Message, "gh: HTTP 502") {
		t.Fatalf("the developer is told once: %+v", notes)
	}
	if len(f.tabs) != 0 || len(f.terminalLines()) != 0 {
		t.Fatalf("no tab or terminal was left behind: %v %v", f.tabs, f.terminalLines())
	}
	if trees := f.git(f.dir, "worktree", "list"); strings.Contains(trees, "fix/") {
		t.Fatalf("no worktree was left behind:\n%s", trees)
	}
}

func TestSecurityFixRequestIsChecked(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.seeBlock(block)
	for name, change := range map[string]func(*SecurityFixRequest){
		"fingerprint": func(r *SecurityFixRequest) { r.Fingerprint = "not-a-fingerprint" },
		"repo":        func(r *SecurityFixRequest) { r.Repo = "../x" },
		"trunk":       func(r *SecurityFixRequest) { r.Trunk = "-x" },
		"workspace":   func(r *SecurityFixRequest) { r.WorkspaceId = "" },
		"agent":       func(r *SecurityFixRequest) { r.Agent = "emacs" },
		"dir":         func(r *SecurityFixRequest) { r.Dir = "relative/dir" },
	} {
		req := f.request(block)
		change(&req)
		if _, err := f.r.AskSecurityFix(context.Background(), req); err == nil {
			t.Errorf("%s: a bad request was accepted", name)
		}
	}
	gone := f.request(block)
	gone.Fingerprint = "0123456789abcdef"
	if res, err := f.r.AskSecurityFix(context.Background(), gone); err != nil || res.Status != RestartFailed || res.Reason != SecurityReasonBlockGone {
		t.Errorf("a block that is gone: %+v %v", res, err)
	}
	own := block
	own.Shared = false
	f.seeBlock(own)
	if res, err := f.r.AskSecurityFix(context.Background(), f.request(own)); err != nil || res.Reason != SecurityReasonNotShared {
		t.Errorf("a failure the pull request caused is its own to fix: %+v %v", res, err)
	}
	if len(f.ghCalls) != 0 || len(f.terminalLines()) != 0 {
		t.Errorf("nothing was started or read: %v", f.ghCalls)
	}
}

// AC10: only the developer's window asks for a fix; an agent in a terminal cannot, on any command of it.
func TestSecurityFixCommandsAreAWindowsOnly(t *testing.T) {
	t.Parallel()
	l := &routeLink{service: &Service{}}
	for _, command := range []string{SecurityFixCommand, SecurityFixStopCommand} {
		if _, err := callAs(l, "proc:block-1", command, map[string]any{}); err == nil {
			t.Errorf("a terminal must not use %s", command)
		}
		if _, err := callAs(l, "", command, map[string]any{}); err == nil {
			t.Errorf("an unverified source must not use %s", command)
		}
	}
	if _, err := callAs(l, "tab:t-1", SecurityFixCommand, map[string]any{}); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Errorf("a window reaches the command (the service has no restarter here): %v", err)
	}
	if got := commandTimeout(SecurityFixCommand); got != restartTimeout {
		t.Errorf("starting an agent takes a worktree: %v", got)
	}
}

func TestSecurityFixResultCarriesTheFix(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	res := f.ask(securityBlock())
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"status":"started"`, `"fix":{`, `"fingerprint":`, `"ticket":101`, `"state":"working"`, `"agentname":"Claude Code"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("the answer lacks %s: %s", want, data)
		}
	}
}
