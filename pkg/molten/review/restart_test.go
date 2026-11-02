// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const restartRepo = "acme/app"

// restartFixture: a project cloned from a local bare remote, on develop, whose PR #9 (feature/9-fix-x) is only on
// origin; its review store holds a published round with two published comments. Terminals, agents and typing are
// fakes that log.
type restartFixture struct {
	*cleanupFixture
	k         PrKey
	store     *Store
	r         *Restarter
	opened    []string
	openMeta  waveobj.MetaMapType
	typed     map[string]string
	runs      map[string]molten.AgentRunInfo
	terms     map[string][]mission.WorktreeTerminal
	review    map[string]bool
	installed map[string]bool
	typeOut   RestartTypeOutcome
	// typeOuts: a terminal's own answer, before typeOut (#1024).
	typeOuts map[string]RestartTypeOutcome
	conv     *molten.ProjectConventions
	// The agent tabs made (#758): name, hidden; the terminals closed, the notifications and the resolved keys.
	tabs     []agentTabCall
	closed   []string
	notes    []molten.NotificationInput
	resolved []string
	gone     map[string]bool
}

type agentTabCall struct {
	workspaceId string
	name        string
	meta        waveobj.MetaMapType
	hidden      bool
}

func makeRestartFixture(t *testing.T) *restartFixture {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := realOf(t.TempDir())
	base := &cleanupFixture{t: t, root: root, remote: filepath.Join(root, "remote.git"), dir: filepath.Join(root, "app"),
		dataDir: filepath.Join(root, "data")}
	base.git(root, "init", "--quiet", "--bare", "-b", "develop", base.remote)
	base.git(root, "clone", "--quiet", base.remote, base.dir)
	base.git(base.dir, "checkout", "--quiet", "-b", "develop")
	base.write(base.dir, "a.txt", "one\n")
	base.git(base.dir, "add", "-A")
	base.git(base.dir, "commit", "--quiet", "-m", "init")
	base.git(base.dir, "push", "--quiet", "origin", "develop")
	other := filepath.Join(root, "author")
	base.git(root, "clone", "--quiet", "-b", "develop", base.remote, other)
	base.git(other, "checkout", "--quiet", "-b", "feature/9-fix-x")
	base.write(other, "b.txt", "feature\n")
	base.git(other, "add", "b.txt")
	base.git(other, "commit", "--quiet", "-m", "feat(#9): x")
	base.git(other, "push", "--quiet", "origin", "feature/9-fix-x")
	base.headOid = base.git(other, "rev-parse", "HEAD")

	f := &restartFixture{cleanupFixture: base, k: PrKey{Repo: restartRepo, Number: 9}, store: MakeStore(base.dataDir),
		typed: map[string]string{}, runs: map[string]molten.AgentRunInfo{}, terms: map[string][]mission.WorktreeTerminal{},
		review: map[string]bool{}, installed: map[string]bool{molten.AgentIdClaude: true, molten.AgentIdCodex: true},
		typeOut: RestartTypeOutcome{Sent: true, Submitted: true}, gone: map[string]bool{}}
	git := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = dir
		cmd.Env = gitEnv()
		return cmd.Output()
	}
	f.r = MakeRestarter(f.store, RestartEnv{
		Git:     git,
		DataDir: base.dataDir,
		Now:     func() time.Time { return time.UnixMilli(5000) },
		Terminals: func(ctx context.Context, path string) []mission.WorktreeTerminal {
			return f.terms[realOf(path)]
		},
		IsReviewTerminal: func(ctx context.Context, blockId string) bool { return f.review[blockId] },
		AgentRun: func(blockId string) (molten.AgentRunInfo, bool) {
			run, ok := f.runs[blockId]
			return run, ok
		},
		TypePrompt: func(ctx context.Context, blockId string, line string) RestartTypeOutcome {
			if out, ok := f.typeOuts[blockId]; ok {
				if !out.Gone {
					f.typed[blockId] = line
				}
				return out
			}
			f.typed[blockId] = line
			return f.typeOut
		},
		OpenTerminal: func(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType, line string) (string, error) {
			f.opened = append(f.opened, line)
			f.openMeta = meta
			return "new-block", nil
		},
		AgentInstalled: func(agent string) bool { return f.installed[agent] },
		AgentOrder:     []string{molten.AgentIdClaude, molten.AgentIdCodex},
		Conventions:    func(dir string) *molten.ProjectConventions { return f.conv },
		AgentTab: func(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType, hidden bool) (string, error) {
			f.tabs = append(f.tabs, agentTabCall{workspaceId: workspaceId, name: name, meta: meta, hidden: hidden})
			return "agent-tab", nil
		},
		BlockExists: func(ctx context.Context, blockId string) bool { return !f.gone[blockId] },
		CloseTerminal: func(ctx context.Context, blockId string) error {
			f.closed = append(f.closed, blockId)
			return nil
		},
		Notify: func(ctx context.Context, input molten.NotificationInput) error {
			f.notes = append(f.notes, input)
			return nil
		},
		ResolveNotices: func(ctx context.Context, keyPrefix string) error {
			f.resolved = append(f.resolved, keyPrefix)
			return nil
		},
	})
	return f
}

func (f *restartFixture) publishRound() {
	f.t.Helper()
	_, _, err := f.store.update(f.k, func(s *State) bool {
		s.Rounds = append(s.Rounds, Round{Id: "round-one-id", StartedAt: 1, HeadOid: f.headOid, PublishedAt: 2,
			GithubReviewId: 77, GithubUrl: "https://github.com/acme/app/pull/9#pullrequestreview-77"})
		s.Comments = append(s.Comments,
			Comment{Id: "c1", Round: "round-one-id", State: CommentStatePublished, Kind: CommentKindChange, Subject: SubjectLine,
				PublishedAs: SubjectLine, GithubCommentId: 111, Anchor: mcpreview.Anchor{Path: "b.txt", Side: "RIGHT", StartLine: 1, Line: 2},
				Original: CommentText{Lang: "fr", Text: "Renomme cette variable"}, Translation: &CommentText{Lang: "en", Text: "Rename this variable"},
				History: []CommentEvent{{Event: EventPublished, Text: "Rename this variable\n<!-- molten-comment:c1 -->"}}},
			Comment{Id: "c2", Round: "round-one-id", State: CommentStatePublished, Kind: CommentKindComment, Subject: SubjectFile,
				PublishedAs: SubjectFile, GithubCommentId: 222, Anchor: mcpreview.Anchor{Path: "a.txt", Side: "RIGHT", Line: 1},
				Original: CommentText{Lang: "en", Text: "Why is this needed?"}},
			Comment{Id: "c3", State: CommentStateStaged, Kind: CommentKindComment, Original: CommentText{Text: "not yet published"}},
		)
		return true
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *restartFixture) request() RestartRequest {
	return RestartRequest{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", Title: "Fix x",
		Start: true, Mode: AgentModeBackground, WorkspaceId: "ws-1", TabName: "Relance #9"}
}

func (f *restartFixture) restart() RestartResult {
	f.t.Helper()
	res, err := f.r.Restart(context.Background(), f.request())
	if err != nil {
		f.t.Fatalf("restart: %v", err)
	}
	return res
}

func (f *restartFixture) round() Round {
	f.t.Helper()
	state, err := f.store.Get(f.k)
	if err != nil || len(state.Rounds) == 0 {
		f.t.Fatalf("no round: %v", err)
	}
	return state.Rounds[len(state.Rounds)-1]
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRestartNeedsAPublishedRound(t *testing.T) {
	f := makeRestartFixture(t)
	if res, err := f.r.Restart(context.Background(), f.request()); err != nil || res.Status != RestartFailed || res.Reason != RestartReasonNoRound {
		t.Errorf("want a refusal before any round is published, got %+v %v", res, err)
	}
	if len(f.opened) != 0 {
		t.Errorf("nothing may start: %v", f.opened)
	}
}

func TestRestartCreatesTheWorktreeAndStartsTheAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	res := f.restart()
	if res.Status != RestartStarted || !res.WorktreeCreated || res.BlockId != "new-block" || res.Agent != molten.AgentIdClaude {
		t.Fatalf("result: %+v", res)
	}
	want := filepath.Join(f.dataDir, "molten", "worktrees")
	if !strings.HasPrefix(res.Worktree, want) || filepath.Base(res.Worktree) != "work-9" {
		t.Errorf("worktree %s, want work-9 under %s", res.Worktree, want)
	}
	if branch := f.git(res.Worktree, "rev-parse", "--abbrev-ref", "HEAD"); branch != "feature/9-fix-x" {
		t.Errorf("the worktree is on %s, want the PR's branch", branch)
	}
	if upstream := f.git(res.Worktree, "rev-parse", "--abbrev-ref", "@{upstream}"); upstream != "origin/feature/9-fix-x" {
		t.Errorf("upstream %s", upstream)
	}
	if main := f.git(f.dir, "rev-parse", "--abbrev-ref", "HEAD"); main != "develop" {
		t.Errorf("the main checkout moved to %s", main)
	}
	if len(f.opened) != 1 {
		t.Fatalf("one terminal, got %v", f.opened)
	}
	command := f.opened[0]
	if !strings.HasPrefix(command, "claude -- ") {
		t.Errorf("the agent starts through the shim with its prompt: %s", command)
	}
	for _, flag := range []string{"--permission-mode", "--disallowedTools", "--sandbox", "--strict-mcp-config", "plan"} {
		if strings.Contains(command, flag) {
			t.Errorf("Restart work runs under the developer's normal profile, found %s in %s", flag, command)
		}
	}
	for _, part := range []string{"PR #9", "feature/9-fix-x", "review round 1", "round-on", "type(#9): description", res.BriefPath, "reply on each GitHub thread"} {
		if !strings.Contains(command, part) {
			t.Errorf("the prompt misses %q: %s", part, command)
		}
	}
	if f.openMeta[waveobj.MetaKey_CmdCwd] != res.Worktree || f.openMeta[molten.WorktreeMetaKey] != res.Worktree {
		t.Errorf("terminal meta %v", f.openMeta)
	}
	round := f.round()
	if round.RestartedAt != 5000 || round.RestartAgent != molten.AgentIdClaude || round.RestartBlockId != "new-block" || round.RestartWorktree != res.Worktree {
		t.Errorf("round not marked: %+v", round)
	}
	if res.State == nil {
		t.Errorf("the marked state is returned for the tabs")
	}
	if !strings.HasPrefix(res.BriefPath, filepath.Join(f.dataDir, "molten", "reviews")) {
		t.Errorf("the brief must be in MoltenTerm's data folder: %s", res.BriefPath)
	}
	brief := readText(t, res.BriefPath)
	for _, part := range []string{
		"# Restart work: PR #9, review round 1",
		"Change request · b.txt R1-R2 · thread 111",
		"> Rename this variable",
		"Comment or question · a.txt (file comment on R1) · thread 222",
		"> Why is this needed?",
		"gh api -X POST repos/acme/app/pulls/9/comments/<thread id>/replies",
		"`type(#9): description`, with the ticket #9",
		"git pull --ff-only",
		"Do not change the ticket's status",
	} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	for _, absent := range []string{"molten-comment", "Renomme", "not yet published", fixPrCommentsSkill} {
		if strings.Contains(brief, absent) {
			t.Errorf("the brief must not hold %q", absent)
		}
	}
}

func TestRestartReusesTheAgentWorktreeAndItsIdleAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	tree := filepath.Join(f.root, "app-9")
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "review-term"}, {BlockId: "agent-term"}}
	f.review["review-term"] = true
	f.runs["review-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateDone}
	res := f.restart()
	if res.Status != RestartSent || res.WorktreeCreated || realOf(res.Worktree) != realOf(tree) || res.BlockId != "agent-term" || res.Agent != molten.AgentIdCodex {
		t.Fatalf("result: %+v", res)
	}
	if len(f.opened) != 0 || f.typed["review-term"] != "" {
		t.Errorf("the review session is never used, and no new terminal: opened %v typed %v", f.opened, f.typed)
	}
	if line := f.typed["agent-term"]; !strings.Contains(line, "PR #9") || len(line) > 600 {
		t.Errorf("typed line (%d chars): %s", len(line), line)
	}
	if round := f.round(); round.RestartedAt == 0 || round.RestartBlockId != "agent-term" {
		t.Errorf("round: %+v", round)
	}
}

func TestRestartSkipsTheReviewSessionTerminal(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	tree := filepath.Join(f.root, "app-9")
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "review-term"}}
	f.review["review-term"] = true
	f.runs["review-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle}
	res := f.restart()
	if res.Status != RestartStarted || len(f.opened) != 1 || len(f.typed) != 0 {
		t.Errorf("a new terminal, never the read-only session: %+v typed %v", res, f.typed)
	}
}

func TestRestartRefusesABusyAgent(t *testing.T) {
	for _, state := range []string{molten.AgentStateWorking, molten.AgentStateWaiting} {
		f := makeRestartFixture(t)
		f.publishRound()
		tree := filepath.Join(f.root, "app-9")
		f.git(f.dir, "fetch", "--quiet", "origin")
		f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
		f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
		f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: state}
		res := f.restart()
		if res.Status != RestartBusy || res.Reason != RestartReasonAgentBusy || res.AgentState != state || len(f.opened) != 0 || len(f.typed) != 0 {
			t.Errorf("%s: %+v", state, res)
		}
		if round := f.round(); round.RestartedAt != 0 {
			t.Errorf("%s: a refused restart marks nothing", state)
		}
	}
}

func TestRestartAgentThatCannotTakeThePrompt(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	tree := filepath.Join(f.root, "app-9")
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle}
	f.typeOut = RestartTypeOutcome{Retry: true, Message: "vim is in the foreground"}
	if res := f.restart(); res.Status != RestartBusy || res.Reason != RestartReasonNotReady || res.Message != "vim is in the foreground" || f.round().RestartedAt != 0 {
		t.Errorf("result: %+v", res)
	}
	f.typeOut = RestartTypeOutcome{Sent: true}
	if res := f.restart(); res.Status != RestartTyped || f.round().RestartedAt == 0 {
		t.Errorf("typed without Enter still restarts: %+v", res)
	}
}

func TestRestartNeverWorksInTheMainCheckout(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "checkout", "--quiet", "-b", "feature/9-fix-x", "origin/feature/9-fix-x")
	res := f.restart()
	if res.Status != RestartFailed || res.Reason != RestartReasonMainCheckout || res.Branch != "feature/9-fix-x" || !strings.Contains(res.Message, "main folder") || len(f.opened) != 0 {
		t.Errorf("result: %+v", res)
	}
	if f.round().RestartedAt != 0 {
		t.Errorf("nothing marked")
	}
}

func TestRestartPutsANewWorktreeBesideTheOthers(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.git(f.dir, "worktree", "add", "--quiet", "-b", "feature/3-other", filepath.Join(f.dir, ".claude", "worktrees", "agent-3"))
	res := f.restart()
	want := filepath.Join(f.dir, ".claude", "worktrees", "feature-9-fix-x")
	if res.Status != RestartStarted || res.Worktree != want {
		t.Errorf("worktree %s, want %s (%+v)", res.Worktree, want, res)
	}
}

func TestRestartLeavesTheReviewWorktreeOutOfTheConvention(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	// The data folder reached through a symlink, as /tmp is on macOS: git lists the real path of the review worktree.
	link := filepath.Join(f.root, "data-link")
	if err := os.Symlink(f.dataDir, link); err != nil {
		t.Fatal(err)
	}
	f.r.env.DataDir = link
	review := filepath.Join(f.dataDir, "molten", "worktrees", "app-x", "review-9")
	f.git(f.dir, "worktree", "add", "--quiet", "--detach", review, "develop")
	res := f.restart()
	if res.Status != RestartStarted || filepath.Base(res.Worktree) != "work-9" {
		t.Errorf("worktree %s (%+v)", res.Worktree, res)
	}
}

func TestRestartFollowsTheProjectsConventionsAndSkill(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.conv = &molten.ProjectConventions{CommitPattern: "type(#N): description", RequireTicket: true}
	f.installed[molten.AgentIdClaude] = false
	tree := filepath.Join(f.root, "app-9")
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
	f.write(tree, ".claude/skills/sf-git-fix-pr-comments/SKILL.md", "skill\n")
	res := f.restart()
	if res.Status != RestartStarted || res.Agent != molten.AgentIdCodex || !strings.HasPrefix(f.opened[0], "codex -- ") {
		t.Fatalf("the first installed agent of the registry: %+v %v", res, f.opened)
	}
	brief := readText(t, res.BriefPath)
	if !strings.Contains(brief, "`sf-git-fix-pr-comments` skill") || !strings.Contains(brief, "type(#9): description") {
		t.Errorf("brief:\n%s", brief)
	}
}

func TestRestartWithoutAnAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.installed = map[string]bool{}
	res := f.restart()
	if res.Status != RestartNoAgent || len(f.opened) != 0 || f.round().RestartedAt != 0 || !strings.Contains(res.Message, res.BriefPath) {
		t.Errorf("result: %+v", res)
	}
}

func TestRestartIsAWindowsOnly(t *testing.T) {
	l := &routeLink{service: &Service{}}
	if _, err := callAs(l, "proc:block-1", RestartCommand, map[string]any{}); err == nil {
		t.Errorf("a terminal must not restart the work")
	}
}
