// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func execGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return out, errors.New(strings.TrimSpace(string(exitErr.Stderr)))
		}
	}
	return out, err
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"}, args...)
	out, err := execGit(context.Background(), dir, full...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// testRepo is a project cloned from a bare origin, with develop and a PR branch feature/7-x one commit ahead.
type testRepo struct {
	project string
	head    string
}

func makeTestRepo(t *testing.T) testRepo {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	seed := filepath.Join(root, "seed")
	project := filepath.Join(root, "project")
	mustGit(t, root, "init", "--bare", origin)
	mustGit(t, root, "init", seed)
	os.WriteFile(filepath.Join(seed, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0644)
	mustGit(t, seed, "add", ".")
	mustGit(t, seed, "commit", "-m", "init")
	mustGit(t, seed, "branch", "develop")
	mustGit(t, seed, "checkout", "-b", "feature/7-x")
	os.WriteFile(filepath.Join(seed, "main.go"), []byte("package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n"), 0644)
	os.WriteFile(filepath.Join(seed, "new.txt"), []byte("new\n"), 0644)
	mustGit(t, seed, "add", ".")
	mustGit(t, seed, "commit", "-m", "feat")
	head := mustGit(t, seed, "rev-parse", "HEAD")
	mustGit(t, seed, "remote", "add", "origin", origin)
	mustGit(t, seed, "push", "--quiet", "origin", "main", "develop", "feature/7-x")
	mustGit(t, root, "clone", "--quiet", origin, project)
	mustGit(t, project, "checkout", "--quiet", "develop")
	return testRepo{project: project, head: head}
}

// #505 Q4: without a linked worktree on the branch, a detached review worktree of the head under the data folder;
// the developer's checkout keeps its branch.
func TestResolveWorktreeDetached(t *testing.T) {
	repo := makeTestRepo(t)
	data := t.TempDir()
	ctx := context.Background()
	head, err := resolveHead(ctx, execGit, repo.project, "feature/7-x", "")
	if err != nil || head != repo.head {
		t.Fatalf("head %q, want %q: %v", head, repo.head, err)
	}
	tree, kind, err := ResolveWorktree(ctx, execGit, data, repo.project, 7, "feature/7-x", head)
	if err != nil {
		t.Fatal(err)
	}
	if kind != mcpreview.WorktreeReview || tree != ReviewTreeDir(data, repo.project, 7) || !strings.HasPrefix(tree, filepath.Join(data, "molten", "worktrees")) {
		t.Fatalf("tree %s (%s)", tree, kind)
	}
	if got := mustGit(t, tree, "rev-parse", "HEAD"); got != repo.head {
		t.Errorf("review worktree at %s, want %s", got, repo.head)
	}
	if branch := mustGit(t, repo.project, "rev-parse", "--abbrev-ref", "HEAD"); branch != "develop" {
		t.Errorf("the developer's checkout moved to %s", branch)
	}
	// Opened again after a push: the same worktree moves to the new head.
	tree2, _, err := ResolveWorktree(ctx, execGit, data, repo.project, 7, "feature/7-x", head)
	if err != nil || tree2 != tree {
		t.Fatalf("second resolve %s: %v", tree2, err)
	}
	if _, err := resolveHead(ctx, execGit, repo.project, "feature/7-x", "0123456789abcdef0123456789abcdef01234567"); err == nil {
		t.Error("an unknown head commit was accepted")
	}
}

// #699: a review worktree whose .git/worktrees entry was pruned is recreated, not left failing every checkout.
func TestResolveWorktreeRecoversFromPrunedMetadata(t *testing.T) {
	repo := makeTestRepo(t)
	data := t.TempDir()
	ctx := context.Background()
	tree, _, err := ResolveWorktree(ctx, execGit, data, repo.project, 7, "feature/7-x", repo.head)
	if err != nil {
		t.Fatal(err)
	}
	link, err := os.ReadFile(filepath.Join(tree, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(strings.TrimSpace(strings.TrimPrefix(string(link), "gitdir:"))); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ResolveWorktree(ctx, execGit, data, repo.project, 7, "feature/7-x", repo.head); err != nil {
		t.Fatalf("a review worktree whose metadata was pruned must be recreated: %v", err)
	}
	if got := mustGit(t, tree, "rev-parse", "HEAD"); got != repo.head {
		t.Errorf("review worktree at %s, want %s", got, repo.head)
	}
}

// #505 Q4: the agent's linked worktree that has the branch is read as it is; the main checkout never is.
func TestResolveWorktreeAgent(t *testing.T) {
	repo := makeTestRepo(t)
	agentTree := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo.project, "worktree", "add", "--quiet", agentTree, "feature/7-x")
	tree, kind, err := ResolveWorktree(context.Background(), execGit, t.TempDir(), repo.project, 7, "feature/7-x", repo.head)
	if err != nil || kind != mcpreview.WorktreeAgent {
		t.Fatalf("tree %s (%s): %v", tree, kind, err)
	}
	if real1, _ := filepath.EvalSymlinks(tree); real1 != mustEval(t, agentTree) {
		t.Errorf("tree %s, want %s", tree, agentTree)
	}
	main := makeTestRepo(t)
	mustGit(t, main.project, "checkout", "--quiet", "feature/7-x")
	_, kind, err = ResolveWorktree(context.Background(), execGit, t.TempDir(), main.project, 7, "feature/7-x", main.head)
	if err != nil || kind != mcpreview.WorktreeReview {
		t.Fatalf("the main checkout was used: %s %v", kind, err)
	}
}

func mustEval(t *testing.T, path string) string {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func TestValidRef(t *testing.T) {
	for _, ok := range []string{"feature/7-x", "fix/12-a.b", "develop"} {
		if !validRef(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "-x", "--upload-pack=x", "a..b", "a b", "a~1", "a:b", "x.lock", "/a", "a/", "a@{1}"} {
		if validRef(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// fakeWave is the wavesrv side of the tests.
type fakeWave struct {
	lock      sync.Mutex
	blocks    map[string]ReviewBlock
	typed     map[string]string
	closed    []string
	published []mcpreview.Update
	installed map[string]bool
	typeErr   error
	typedCh   chan string
	files     map[string][]byte
	// after: the block each terminal was split under; gh: the fake gh's answers by its first two words.
	after    map[string]string
	gh       map[string]string
	ghErr    error
	ghCalls  [][]string
	prompts  map[string][]string
	busy     bool
	draft    bool
	saved    map[string]any
	readFile map[string][]byte
}

func (f *fakeWave) env(repo testRepo, data string) Env {
	return Env{
		DataDir:        data,
		MoltenPath:     func() string { return "/data/bin/molten" },
		Git:            execGit,
		AgentInstalled: func(agent string) bool { return f.installed[agent] },
		AgentOrder:     []string{"claude", "codex"},
		WriteFile: func(prefix string, ext string, data []byte) (string, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			path := "/data/molten/agent-launch/" + prefix + ext
			f.files[path] = data
			return path, nil
		},
		Guide: func() ([]byte, error) { return []byte("# guide"), nil },
		CreateTerminal: func(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType) (string, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			id := "block" + string(rune('a'+len(f.blocks)))
			f.after[id] = afterBlockId
			stored := waveobj.MetaMapType{}
			raw, _ := json.Marshal(meta)
			json.Unmarshal(raw, &stored)
			f.blocks[id] = ReviewBlock{BlockId: id, TabId: tabId, Meta: stored}
			return id, nil
		},
		StartAndType: func(ctx context.Context, tabId string, blockId string, line string) error {
			f.lock.Lock()
			f.typed[blockId] = line
			err := f.typeErr
			f.lock.Unlock()
			f.typedCh <- blockId
			return err
		},
		CloseTerminal: func(ctx context.Context, tabId string, blockId string) error {
			f.lock.Lock()
			defer f.lock.Unlock()
			delete(f.blocks, blockId)
			f.closed = append(f.closed, blockId)
			return nil
		},
		ReviewBlocks: func(ctx context.Context) ([]ReviewBlock, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			var rtn []ReviewBlock
			for _, b := range f.blocks {
				rtn = append(rtn, b)
			}
			return rtn, nil
		},
		BlockExists: func(ctx context.Context, blockId string) bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			_, ok := f.blocks[blockId]
			return ok
		},
		VerifyToken: func(token string) (string, error) {
			if blockId, ok := strings.CutPrefix(token, "jwt-"); ok {
				return blockId, nil
			}
			return "", errors.New("bad token")
		},
		BlockIsLocal: func(ctx context.Context, blockId string) bool { return blockId != "blockremote" },
		Publish: func(scope string, update mcpreview.Update) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.published = append(f.published, update)
		},
		Locale: func() string { return "fr" },
		ReadFile: func(path string) []byte {
			if strings.HasSuffix(path, ".saasfoundry.json") {
				return []byte(`{"language":{"tickets":"en"}}`)
			}
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.readFile[path]
		},
		Now: func() time.Time { return time.UnixMilli(1000) },
		Gh: func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.ghCalls = append(f.ghCalls, args)
			if f.ghErr != nil {
				return nil, f.ghErr
			}
			answer, ok := f.gh[strings.Join(args[:2], " ")]
			if !ok {
				return nil, errors.New("not found")
			}
			return []byte(answer), nil
		},
		TypePrompt: func(ctx context.Context, blockId string, line string) TypeOutcome {
			f.lock.Lock()
			defer f.lock.Unlock()
			if f.busy {
				return TypeOutcome{Retry: true, Message: "Claude Code is working: nothing was typed."}
			}
			f.prompts[blockId] = append(f.prompts[blockId], line)
			return TypeOutcome{Sent: true, Submitted: !f.draft}
		},
		SaveRecord: func(ctx context.Context, blockId string, rec any) error {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.saved[blockId] = rec
			return nil
		},
	}
}

func makeFakeWave() *fakeWave {
	return &fakeWave{blocks: map[string]ReviewBlock{}, typed: map[string]string{}, installed: map[string]bool{"claude": true},
		typedCh: make(chan string, 4), files: map[string][]byte{}, after: map[string]string{}, gh: map[string]string{},
		prompts: map[string][]string{}, saved: map[string]any{}, readFile: map[string][]byte{}}
}

func startReq(repo testRepo) mcpreview.StartRequest {
	return mcpreview.StartRequest{TabId: "tab1", ProjectDir: repo.project, Repo: "Owner/Repo", Number: 7, Title: "x",
		HeadRef: "feature/7-x", BaseRef: "develop"}
}

// FR-REV-004 AC1, AC5: one session per PR, started in its own terminal with the token in its environment only;
// asking again reattaches it; closing the terminal ends it.
func TestStartAttachEnd(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	m := MakeManager(f.env(repo, t.TempDir()))
	ctx := context.Background()
	res, err := m.Start(ctx, "", startReq(repo))
	if err != nil || res.Status != mcpreview.StatusStarted || res.Session == nil {
		t.Fatalf("start %+v: %v", res, err)
	}
	blockId := <-f.typedCh
	s := res.Session
	if s.Agent != "claude" || s.HeadOid != repo.head || s.WorktreeKind != mcpreview.WorktreeReview || s.BlockId != blockId {
		t.Errorf("session %+v", s)
	}
	block := f.blocks[blockId]
	token := block.Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	if len(token) != 64 || block.Meta.GetString(waveobj.MetaKey_CmdCwd, "") != s.Worktree || block.Meta.GetString(waveobj.MetaKey_Controller, "") != "shell" {
		t.Errorf("block meta %+v", block.Meta)
	}
	// #916: the session's terminal runs hidden, the AI panel shows it on demand.
	if !block.Meta.GetBool(mcpreview.HiddenMetaKey, false) {
		t.Errorf("the session's terminal is not hidden: %+v", block.Meta)
	}
	if strings.Contains(f.typed[blockId], token) || !strings.HasPrefix(f.typed[blockId], "claude --setting-sources user --permission-mode default") {
		t.Errorf("typed %q", f.typed[blockId])
	}
	if raw, _ := json.Marshal(s); strings.Contains(string(raw), token) {
		t.Errorf("the session info shows the token: %s", raw)
	}
	again, err := m.Start(ctx, "", startReq(repo))
	if err != nil || again.Status != mcpreview.StatusAttached || again.Session.Id != s.Id || len(f.blocks) != 1 {
		t.Fatalf("reattach %+v: %v", again, err)
	}
	if got := m.Get(ctx, mcpreview.SessionKey{Repo: "owner/repo", Number: 7}); got == nil || got.Id != s.Id {
		t.Errorf("get %+v", got)
	}
	m.BlockClosed(blockId)
	if m.Get(ctx, mcpreview.SessionKey{Id: s.Id}) != nil {
		t.Error("the session outlived its terminal")
	}
	last := f.published[len(f.published)-1]
	if !last.Ended || last.Session.Id != s.Id {
		t.Errorf("last update %+v", last)
	}
	res, _ = m.Start(ctx, "", startReq(repo))
	<-f.typedCh
	if err := m.End(ctx, mcpreview.SessionKey{Id: res.Session.Id}); err != nil || len(f.closed) != 1 || len(m.List(ctx).Sessions) != 0 {
		t.Errorf("end: %v closed %v", err, f.closed)
	}
}

// FR-REV-004 AC6: without a supported agent the session does not start and says why.
func TestStartWithoutAgent(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	f.installed = map[string]bool{}
	m := MakeManager(f.env(repo, t.TempDir()))
	res, err := m.Start(context.Background(), "tab1", startReq(repo))
	if err != nil || res.Status != mcpreview.StatusNoAgent || res.Reason != mcpreview.ReasonNotInstalled || !strings.Contains(res.Message, "work without it") || len(f.blocks) != 0 {
		t.Fatalf("start %+v: %v", res, err)
	}
	req := startReq(repo)
	req.Agent = "codex"
	f.installed = map[string]bool{"claude": true}
	if res, _ := m.Start(context.Background(), "tab1", req); res.Status != mcpreview.StatusNoAgent || res.Reason != mcpreview.ReasonAgentMissing || res.AgentName != "Codex" {
		t.Errorf("requested codex: %+v", res)
	}
	f.installed = map[string]bool{"codex": true}
	res, err = m.Start(context.Background(), "tab1", startReq(repo))
	if err != nil || res.Status != mcpreview.StatusStarted || res.Session.Agent != "codex" {
		t.Fatalf("codex: %+v %v", res, err)
	}
	blockId := <-f.typedCh
	if !strings.HasPrefix(f.typed[blockId], "codex --sandbox read-only -c ") {
		t.Errorf("typed %q", f.typed[blockId])
	}
	// #664: the review folder and the project are untrusted for the run, so the PR's .codex/ never loads.
	for _, dir := range []string{res.Session.Worktree, res.Session.ProjectDir} {
		if !strings.Contains(f.typed[blockId], tomlString(dir)+`={trust_level="untrusted"}`) {
			t.Errorf("%s is not untrusted in %q", dir, f.typed[blockId])
		}
	}
}

func TestStartRefusesBadRequests(t *testing.T) {
	repo := makeTestRepo(t)
	m := MakeManager(makeFakeWave().env(repo, t.TempDir()))
	for _, mutate := range []func(r *mcpreview.StartRequest){
		func(r *mcpreview.StartRequest) { r.Repo = "no-slash" },
		func(r *mcpreview.StartRequest) { r.Number = 0 },
		func(r *mcpreview.StartRequest) { r.ProjectDir = "relative" },
		func(r *mcpreview.StartRequest) { r.HeadRef = "--upload-pack=evil" },
		func(r *mcpreview.StartRequest) { r.Agent = "gemini" },
	} {
		req := startReq(repo)
		mutate(&req)
		if _, err := m.Start(context.Background(), "tab1", req); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
}

// A shell that shows no prompt: the session says what to type.
func TestStartTypingFails(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	f.typeErr = errors.New("the terminal showed no prompt")
	m := MakeManager(f.env(repo, t.TempDir()))
	res, _ := m.Start(context.Background(), "tab1", startReq(repo))
	<-f.typedCh
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got := m.Get(context.Background(), mcpreview.SessionKey{Id: res.Session.Id})
		if got.State == mcpreview.StateFailed {
			if got.Reason != mcpreview.ReasonNotStarted || got.Message != "the terminal showed no prompt" || !strings.Contains(got.Command, "claude --setting-sources user --permission-mode") {
				t.Errorf("failed session %+v", got)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the session never said the agent did not start")
}

// FR-REV-004 AC4, AC5: the tools answer only the session's own terminal, on a local link, with its token; after a
// restart the session is found again from its terminal.
func TestHelloScopeAndRestart(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	m := MakeManager(env)
	ctx := context.Background()
	res, _ := m.Start(ctx, "tab1", startReq(repo))
	blockId := <-f.typedCh
	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	refused := []mcpreview.HelloRequest{
		{Token: "jwt-" + blockId, SessionToken: "wrong"},
		{Token: "jwt-otherblock", SessionToken: token},
		{Token: "bad", SessionToken: token},
		{Token: "jwt-" + blockId},
	}
	for _, req := range refused {
		if _, err := m.Hello(ctx, "proc:1", req); err == nil || err.Error() != mcpreview.ErrNotInMoltenTerm {
			t.Errorf("hello %+v: %v", req, err)
		}
	}
	if _, err := m.Hello(ctx, "", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token}); err == nil {
		t.Error("a hello from a source not on its link was accepted")
	}
	// A restarted wavesrv: a new manager finds the session in the terminal's meta.
	m2 := MakeManager(env)
	hello, err := m2.Hello(ctx, "proc:1", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token})
	if err != nil || hello.Number != 7 {
		t.Fatalf("hello after restart %+v: %v", hello, err)
	}
	if got := m2.Get(ctx, mcpreview.SessionKey{Id: res.Session.Id}); got == nil || !got.Connected {
		t.Errorf("session after restart %+v", got)
	}
	call := func(tool string, args string) mcpbrowser.CallResult {
		return m2.Call(ctx, "proc:1", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: tool, Args: json.RawMessage(args)})
	}
	if r := m2.Call(ctx, "proc:2", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: mcpreview.ToolContext}); !r.IsError {
		t.Error("another source used the connection")
	}
	ctxResult := call(mcpreview.ToolContext, "")
	if ctxResult.IsError || !strings.Contains(ctxResult.Content[0].Text, `"developerlanguage": "fr"`) ||
		!strings.Contains(ctxResult.Content[0].Text, `"baseoid"`) || strings.Contains(ctxResult.Content[0].Text, token) {
		t.Errorf("context %+v", ctxResult)
	}
	files := call(mcpreview.ToolFiles, "{}")
	if files.IsError || !strings.Contains(files.Content[0].Text, `"path": "new.txt"`) || !strings.Contains(files.Content[0].Text, `"status": "added"`) {
		t.Errorf("files %+v", files)
	}
	diff := call(mcpreview.ToolDiff, `{"path":"main.go","context":1}`)
	if diff.IsError || !strings.Contains(diff.Content[0].Text, `+	println("hi")`) {
		t.Errorf("diff %+v", diff)
	}
	if r := call(mcpreview.ToolDiff, `{"path":"/etc/passwd"}`); !r.IsError {
		t.Errorf("a file outside the PR was diffed: %+v", r)
	}
	if r := call(mcpreview.ToolSelection, "{}"); r.IsError || !strings.Contains(r.Content[0].Text, "No lines") {
		t.Errorf("selection %+v", r)
	}
	anchor := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 5}
	if err := m2.SetSelection(ctx, mcpreview.SelectionRequest{SessionKey: mcpreview.SessionKey{Id: res.Session.Id}, Anchor: anchor, Text: "x"}); err != nil {
		t.Fatal(err)
	}
	if r := call(mcpreview.ToolSelection, "{}"); !strings.Contains(r.Content[0].Text, `"startline": 3`) {
		t.Errorf("selection %+v", r)
	}
	m2.Bye("proc:1", hello.ConnId)
	if r := call(mcpreview.ToolContext, "{}"); !r.IsError || r.Content[0].Text != mcpreview.ErrSessionEnded {
		t.Errorf("call after bye %+v", r)
	}
}

// DS-REV-005: the output tools only add posts, checked, and tell the windows; a new briefing replaces the old one.
func TestOutputTools(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	m := MakeManager(f.env(repo, t.TempDir()))
	ctx := context.Background()
	res, _ := m.Start(ctx, "tab1", startReq(repo))
	blockId := <-f.typedCh
	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	hello, err := m.Hello(ctx, "proc:9", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token})
	if err != nil {
		t.Fatal(err)
	}
	call := func(tool string, args string) mcpbrowser.CallResult {
		return m.Call(ctx, "proc:9", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: tool, Args: json.RawMessage(args)})
	}
	anchor := `{"path":"main.go","side":"RIGHT","line":4}`
	ok := []struct{ tool, args string }{
		{mcpreview.ToolPostBriefing, `{"markdown":"first"}`},
		{mcpreview.ToolPostBriefing, `{"markdown":"second"}`},
		{mcpreview.ToolPostExplanation, `{"anchor":` + anchor + `,"markdown":"why","depth":"detailed","principles":["KISS"],"sources":["main.go:4"]}`},
		{mcpreview.ToolProposeComment, `{"anchor":` + anchor + `,"kind":"change","text":"rename"}`},
	}
	for _, c := range ok {
		if r := call(c.tool, c.args); r.IsError || !strings.Contains(r.Content[0].Text, "Nothing was published") {
			t.Errorf("%s: %+v", c.tool, r)
		}
	}
	bad := []struct{ tool, args string }{
		{mcpreview.ToolPostBriefing, `{"markdown":"  "}`},
		{mcpreview.ToolPostExplanation, `{"anchor":{"path":"a","side":"UP","line":1},"markdown":"x"}`},
		{mcpreview.ToolPostExplanation, `{"anchor":` + anchor + `,"markdown":"x","depth":"deep"}`},
		{mcpreview.ToolProposeComment, `{"anchor":` + anchor + `,"kind":"approve","text":"x"}`},
		{mcpreview.ToolKeepNote, `{"explanationid":"nope"}`},
		// A translation MoltenTerm did not ask for (FR-REV-010).
		{mcpreview.ToolSetTranslation, `{"commentid":"c1","text":"hello"}`},
		{"review_merge", `{}`},
	}
	for _, c := range bad {
		if r := call(c.tool, c.args); !r.IsError {
			t.Errorf("%s %s accepted", c.tool, c.args)
		}
	}
	posts, err := m.Posts(ctx, mcpreview.SessionKey{Id: res.Session.Id})
	if err != nil || len(posts.Posts) != 3 || posts.Posts[0].Kind != mcpreview.PostBriefing || posts.Posts[0].Markdown != "second" {
		t.Fatalf("posts %+v: %v", posts, err)
	}
	explanation := posts.Posts[1]
	if r := call(mcpreview.ToolKeepNote, `{"explanationid":"`+explanation.Id+`"}`); r.IsError {
		t.Errorf("keep note %+v", r)
	}
	postEvents := 0
	for _, u := range f.published {
		if u.Post != nil {
			postEvents++
		}
	}
	if postEvents != 5 {
		t.Errorf("%d post events", postEvents)
	}
}

func TestOsLocaleParsing(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "C")
	t.Setenv("LANG", "fr_FR.UTF-8")
	if got := osLocale(); got != "fr" {
		t.Errorf("locale %q", got)
	}
}
