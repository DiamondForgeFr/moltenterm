// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

func writeLaunchFile(t *testing.T, dir string, rel string, content string) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestDetectLaunchRecipeNpmWorkspaces(t *testing.T) {
	dir := t.TempDir()
	writeLaunchFile(t, dir, "package.json", `{"name": "df", "workspaces": ["apps/*", "packages/*"], "scripts": {"dev": "turbo dev"}}`)
	writeLaunchFile(t, dir, "package-lock.json", "{}")
	writeLaunchFile(t, dir, "apps/api/package.json", `{"name": "api", "scripts": {"db:migrate": "prisma migrate deploy", "db:update:dev": "prisma migrate dev", "dev": "nest start --watch"}}`)
	writeLaunchFile(t, dir, "apps/api/.env", "DATABASE_URL=postgres://x\nPORT=3500\n")
	writeLaunchFile(t, dir, "apps/web/package.json", `{"name": "web", "scripts": {"dev": "vite"}}`)
	writeLaunchFile(t, dir, "packages/ui/package.json", `{"name": "ui", "scripts": {"build": "tsc"}}`)
	recipe := detectLaunchRecipe(dir)
	if recipe == nil {
		t.Fatal("no recipe proposed")
	}
	want := []LaunchRecipeStep{{Id: "install", Run: "npm install"}, {Id: "migrate-api", Run: "npm run db:update:dev -w apps/api"}}
	if fmt.Sprint(recipe.Prepare) != fmt.Sprint(want) {
		t.Fatalf("prepare: %+v", recipe.Prepare)
	}
	servers := []LaunchRecipeServer{{Id: "api", Run: "npm run dev -w apps/api", Port: 3500}, {Id: "web", Run: "npm run dev -w apps/web", Port: 5173}}
	if fmt.Sprint(recipe.Servers) != fmt.Sprint(servers) {
		t.Fatalf("servers: %+v", recipe.Servers)
	}
	if recipe.Url != "http://localhost:5173" || recipe.Where != "main" {
		t.Fatalf("recipe: %+v", recipe)
	}
}

func TestDetectLaunchRecipeSinglePackage(t *testing.T) {
	dir := t.TempDir()
	writeLaunchFile(t, dir, "package.json", `{"scripts": {"dev": "next dev -p 4000", "migrate": "node migrate.js"}}`)
	writeLaunchFile(t, dir, "pnpm-lock.yaml", "")
	recipe := detectLaunchRecipe(dir)
	if recipe == nil || len(recipe.Servers) != 1 {
		t.Fatalf("recipe: %+v", recipe)
	}
	if recipe.Prepare[0].Run != "pnpm install" || recipe.Prepare[1].Run != "pnpm run migrate" || recipe.Servers[0].Run != "pnpm run dev" || recipe.Servers[0].Port != 4000 || recipe.Url != "http://localhost:4000" {
		t.Fatalf("recipe: %+v", recipe)
	}
	writeLaunchFile(t, dir, "package.json", `{"scripts": {"build": "tsc"}}`)
	if recipe := detectLaunchRecipe(dir); recipe != nil {
		t.Fatalf("a project without a dev script proposes nothing: %+v", recipe)
	}
	if recipe := detectLaunchRecipe(t.TempDir()); recipe != nil {
		t.Fatalf("a folder without package.json proposes nothing: %+v", recipe)
	}
}

func TestLaunchRecipeProposalAndSave(t *testing.T) {
	dir := t.TempDir()
	writeLaunchFile(t, dir, ".molten/project.json", `{"schema": 1, "name": "x", "launch": {
	  "prepare": [{"id": "migrate", "run": "./scripts/migrate.sh", "env": {"MODE": "dev x"}}],
	  "servers": [{"id": "web", "run": "npm run dev", "port": 5173}]
	}}`)
	writeLaunchFile(t, dir, "scripts/migrate.sh", "#!/bin/sh\n")
	writeLaunchFile(t, dir, "package.json", `{"scripts": {"dev": "vite"}}`)
	l := MakeLaunches(t.TempDir(), plainRunner, nil)
	answer, err := l.RecipeOf(LaunchRecipeRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Saved != nil || answer.ProposalFrom != LaunchRecipeFromProject || answer.Proposal.Prepare[0].Run != "MODE='dev x' ./scripts/migrate.sh" {
		t.Fatalf("answer: %+v", answer)
	}
	_, err = l.SaveRecipe(LaunchSaveRecipeRequest{Dir: dir, Recipe: LaunchRecipe{Servers: []LaunchRecipeServer{{Run: "x", Cwd: "../elsewhere"}}}})
	if err == nil || !strings.Contains(err.Error(), "leaves the project") {
		t.Fatalf("a folder outside the project: %v", err)
	}
	_, err = l.SaveRecipe(LaunchSaveRecipeRequest{Dir: dir, Recipe: LaunchRecipe{Servers: []LaunchRecipeServer{{Run: "  "}}}})
	if err == nil {
		t.Fatal("a recipe without a server must be refused")
	}
	answer, err = l.SaveRecipe(LaunchSaveRecipeRequest{Dir: dir, Recipe: LaunchRecipe{
		Prepare: []LaunchRecipeStep{{Id: "Install Deps", Run: " npm install "}, {Run: ""}},
		Servers: []LaunchRecipeServer{{Id: "web", Run: "npm run dev", Cwd: "./", Port: 5173}, {Id: "web", Run: "npm run api"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	saved := answer.Saved
	if saved == nil || saved.Where != "main" || len(saved.Prepare) != 1 || saved.Prepare[0].Id != "install-deps" || saved.Prepare[0].Run != "npm install" ||
		saved.Servers[0].Cwd != "" || saved.Servers[1].Id != "web-2" {
		t.Fatalf("saved: %+v", saved)
	}
	again := MakeLaunches(l.baseDir, plainRunner, nil)
	if answer, _ := again.RecipeOf(LaunchRecipeRequest{Dir: dir}); answer.Saved == nil || answer.Saved.Servers[0].Port != 5173 {
		t.Fatalf("the saved recipe is kept: %+v", answer)
	}
}

// identityRunner runs git with an identity: a stash is a commit.
func identityRunner(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, errors.New(name + " " + strings.Join(args, " ") + ": " + strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

type launchFixture struct {
	l       *Launches
	dir     string
	origin  string
	logFile string
	port    int
	server  string
	prSha   string
	lock    sync.Mutex
	events  []LaunchState
}

// freePort picks a free port below the systems' ephemeral ranges (49152 and up, 32768 and up on Linux) (#1208): a
// port the system hands out for 127.0.0.1:0 is released before node listens on it, and on a loaded machine another
// connection was given it in between, so the launch's server failed with EADDRINUSE.
func freePort(t *testing.T) int {
	t.Helper()
	for range 1000 {
		port := 20000 + rand.IntN(10000)
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		ln.Close()
		return port
	}
	t.Fatal("no free port between 20000 and 30000")
	return 0
}

const launchServerJs = `const fs = require("fs");
require("http").createServer((req, res) => res.end(fs.readFileSync("version.txt"))).listen(Number(process.argv[2]));
`

// A project with an origin: develop, a PR branch on origin only, and a local Upcoming branch; its recipe migrates
// (appending to a log outside the checkout) and serves version.txt with node.
func makeLaunchFixture(t *testing.T) *launchFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("launch steps use /bin/sh")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	saved := readLoginPath
	readLoginPath = func() string { return os.Getenv("PATH") }
	t.Cleanup(func() { readLoginPath = saved })
	tools := t.TempDir()
	f := &launchFixture{origin: t.TempDir(), dir: t.TempDir(), logFile: filepath.Join(tools, "migrations.log"), port: freePort(t), server: filepath.Join(tools, "server.js")}
	writeLaunchFile(t, tools, "server.js", launchServerJs)
	gitIn(t, f.origin, "init", "-q", "--bare", "-b", "develop")
	gitIn(t, f.dir, "init", "-q", "-b", "develop")
	gitIn(t, f.dir, "remote", "add", "origin", f.origin)
	commitFile(t, f.dir, "version.txt", "develop", "init")
	gitIn(t, f.dir, "push", "-q", "-u", "origin", "develop")
	gitIn(t, f.dir, "checkout", "-q", "-b", "feature/1-pr")
	commitFile(t, f.dir, "version.txt", "pr1", "pr")
	gitIn(t, f.dir, "push", "-q", "origin", "feature/1-pr")
	f.prSha = headOf(t, f.dir, "HEAD")
	gitIn(t, f.dir, "checkout", "-q", "develop")
	gitIn(t, f.dir, "branch", "-q", "-D", "feature/1-pr")
	gitIn(t, f.dir, "checkout", "-q", "-b", "feature/2-upcoming")
	commitFile(t, f.dir, "version.txt", "upcoming2", "upcoming")
	gitIn(t, f.dir, "checkout", "-q", "develop")
	f.l = MakeLaunches(t.TempDir(), identityRunner, func(state LaunchState) {
		f.lock.Lock()
		defer f.lock.Unlock()
		f.events = append(f.events, state)
	})
	f.l.holders = func(ctx context.Context, port int) ([]LaunchPortHolder, error) { return nil, nil }
	f.saveRecipe(t, LaunchRecipe{
		Prepare: []LaunchRecipeStep{{Id: "migrate", Run: "cat version.txt >> " + f.logFile + " && echo >> " + f.logFile}},
		Servers: []LaunchRecipeServer{{Id: "web", Run: fmt.Sprintf("exec node %s %d", f.server, f.port), Port: f.port}},
	})
	t.Cleanup(func() { f.l.Stop(LaunchDirRequest{Dir: f.dir}) })
	return f
}

func (f *launchFixture) saveRecipe(t *testing.T, recipe LaunchRecipe) {
	t.Helper()
	if _, err := f.l.SaveRecipe(LaunchSaveRecipeRequest{Dir: f.dir, Recipe: recipe}); err != nil {
		t.Fatal(err)
	}
}

func waitLaunch(t *testing.T, l *Launches, dir string, want string) LaunchState {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for {
		state, err := l.State(LaunchDirRequest{Dir: dir})
		if err != nil {
			t.Fatal(err)
		}
		if state.State == want {
			return state
		}
		if time.Now().After(deadline) {
			t.Fatalf("launch is %s, waited for %s: %+v", state.State, want, state)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func served(t *testing.T, port int) string {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return string(data)
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d still runs", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func serverPid(state LaunchState) int {
	for _, step := range state.Steps {
		if step.Kind == LaunchStepServer {
			return step.Pid
		}
	}
	return 0
}

func TestLaunchReplacesAndGoesBackToTheTrunk(t *testing.T) {
	f := makeLaunchFixture(t)
	pr := LaunchTarget{Kind: LaunchTargetPr, Number: 1, Branch: "feature/1-pr"}
	plan, err := f.l.Plan(LaunchPlanRequest{Dir: f.dir, Target: pr})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Running != nil || plan.Branch != "develop" || plan.DirtyCount != 0 || plan.ServeDir != f.dir || plan.Worktree {
		t.Fatalf("plan: %+v", plan)
	}
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: pr}); err != nil {
		t.Fatal(err)
	}
	first := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	if got := served(t, f.port); got != "pr1" {
		t.Fatalf("served %q", got)
	}
	if first.Commit != f.prSha || first.Previous != "develop" || first.Url != fmt.Sprintf("http://localhost:%d", f.port) {
		t.Fatalf("state: %+v", first)
	}
	if head := gitIn(t, f.dir, "rev-parse", "HEAD"); head != f.prSha || gitIn(t, f.dir, "status", "--porcelain", "--untracked-files=no") != "" {
		t.Fatalf("the checkout is not detached at the PR's head: %s", head)
	}
	plan, _ = f.l.Plan(LaunchPlanRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetBranch, Branch: "feature/2-upcoming"}})
	if plan.Running == nil || plan.Running.Id != first.Id || plan.Branch != "" {
		t.Fatalf("the plan names the running version: %+v", plan)
	}
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetBranch, Branch: "feature/2-upcoming"}}); err != nil {
		t.Fatal(err)
	}
	waitGone(t, serverPid(first))
	second := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	if second.Id == first.Id || served(t, f.port) != "upcoming2" || second.Previous != "develop" {
		t.Fatalf("second: %+v", second)
	}
	f.lock.Lock()
	for _, event := range f.events {
		if event.Id == first.Id && event.State == LaunchStateRunning && second.StartedAt < event.ReadyAt {
			t.Errorf("the first version ran after the second started")
		}
	}
	f.lock.Unlock()
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetTrunk}}); err != nil {
		t.Fatal(err)
	}
	waitGone(t, serverPid(second))
	back := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	if back.Target.Branch != "develop" || back.Previous != "" || served(t, f.port) != "develop" {
		t.Fatalf("back: %+v", back)
	}
	if branch := gitIn(t, f.dir, "symbolic-ref", "--short", "HEAD"); branch != "develop" {
		t.Fatalf("on %s after Back to the trunk", branch)
	}
	stopped, err := f.l.Stop(LaunchDirRequest{Dir: f.dir})
	if err != nil || stopped.State != LaunchStateStopped {
		t.Fatalf("stop: %+v, %v", stopped, err)
	}
	waitGone(t, serverPid(back))
	data, _ := os.ReadFile(f.logFile)
	if string(data) != "pr1\nupcoming2\ndevelop\n" {
		t.Fatalf("migrations ran %q", data)
	}
	log, err := f.l.ReadLog(LaunchLogRequest{Dir: f.dir, Step: "checkout"})
	if err != nil || !strings.Contains(log.Text, "git checkout develop") {
		t.Fatalf("checkout log: %q, %v", log.Text, err)
	}
}

func TestLaunchDirtyCheckoutGuard(t *testing.T) {
	f := makeLaunchFixture(t)
	writeLaunchFile(t, f.dir, "version.txt", "local work")
	pr := LaunchTarget{Kind: LaunchTargetPr, Number: 1, Branch: "feature/1-pr"}
	plan, err := f.l.Plan(LaunchPlanRequest{Dir: f.dir, Target: pr})
	if err != nil || plan.DirtyCount != 1 || !strings.Contains(plan.Dirty[0], "version.txt") {
		t.Fatalf("plan: %+v, %v", plan, err)
	}
	_, err = f.l.Start(LaunchStartRequest{Dir: f.dir, Target: pr})
	var uiErr *uimsg.Error
	if !errors.As(err, &uiErr) || uiErr.Text.Code != "mission.launch.dirty" {
		t.Fatalf("a dirty checkout must block the switch: %v", err)
	}
	if state, _ := f.l.State(LaunchDirRequest{Dir: f.dir}); state.Id != "" {
		t.Fatalf("nothing starts: %+v", state)
	}
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: pr, Stash: true}); err != nil {
		t.Fatal(err)
	}
	state := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	stashes := gitIn(t, f.dir, "stash", "list")
	if !strings.Contains(stashes, "moltenterm launch") || !strings.Contains(stashes, "before PR #1") || !strings.Contains(state.Stash, "before PR #1") {
		t.Fatalf("the changes are set aside: %q, %+v", stashes, state)
	}
	if gitIn(t, f.dir, "stash", "show", "-p", "stash@{0}") == "" {
		t.Fatal("the stash is empty")
	}
}

func TestLaunchFailedStepRetries(t *testing.T) {
	f := makeLaunchFixture(t)
	flag := filepath.Join(t.TempDir(), "db-up")
	f.saveRecipe(t, LaunchRecipe{
		Prepare: []LaunchRecipeStep{{Id: "install", Run: "echo installed"}, {Id: "migrate", Run: "test -f " + flag + " || { echo 'database is down'; echo 'npm error code 4'; echo 'npm error command sh -c node migrate.js'; exit 4; }"}},
		Servers: []LaunchRecipeServer{{Id: "web", Run: fmt.Sprintf("exec node %s %d", f.server, f.port), Port: f.port}},
	})
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetBranch, Branch: "feature/2-upcoming"}}); err != nil {
		t.Fatal(err)
	}
	failed := waitLaunch(t, f.l, f.dir, LaunchStateFailed)
	step := failed.Steps[2]
	if step.Id != "prepare-migrate" || step.State != LaunchStepFailed || step.ErrorText.Code != "mission.launch.stepFailed" ||
		step.ErrorText.Vars["code"] != "4" || step.ErrorText.Vars["line"] != "database is down" || failed.Steps[1].State != LaunchStepDone || failed.Steps[3].State != LaunchStepPending {
		t.Fatalf("failed: %+v", failed)
	}
	writeLaunchFile(t, filepath.Dir(flag), filepath.Base(flag), "")
	if _, err := f.l.Retry(LaunchDirRequest{Dir: f.dir}); err != nil {
		t.Fatal(err)
	}
	running := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	if running.Id != failed.Id || served(t, f.port) != "upcoming2" {
		t.Fatalf("running: %+v", running)
	}
	log, _ := f.l.ReadLog(LaunchLogRequest{Dir: f.dir, Step: "prepare-install"})
	if strings.Count(log.Text, "\ninstalled\n") != 1 {
		t.Fatalf("Retry ran the steps before the failed one again: %q", log.Text)
	}
	if _, err := f.l.Retry(LaunchDirRequest{Dir: f.dir}); err == nil {
		t.Fatal("a running launch cannot be retried")
	}
}

func TestLaunchServerThatStopsFailsTheLaunch(t *testing.T) {
	f := makeLaunchFixture(t)
	f.saveRecipe(t, LaunchRecipe{Servers: []LaunchRecipeServer{{Id: "api", Run: "echo 'EADDRINUSE'; exit 3", Port: f.port}}})
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetTrunk}}); err != nil {
		t.Fatal(err)
	}
	failed := waitLaunch(t, f.l, f.dir, LaunchStateFailed)
	step := failed.Steps[1]
	if step.State != LaunchStepFailed || step.ErrorText.Code != "mission.launch.serverExited" || step.ErrorText.Vars["code"] != "3" || step.ErrorText.Vars["line"] != "EADDRINUSE" {
		t.Fatalf("failed: %+v", failed)
	}
}

func TestLaunchStopsPortHoldersOnlyWhenConfirmed(t *testing.T) {
	f := makeLaunchFixture(t)
	holder := exec.Command("sleep", "600")
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	holderDone := make(chan struct{})
	go func() {
		holder.Wait()
		close(holderDone)
	}()
	t.Cleanup(func() {
		holder.Process.Kill()
		<-holderDone
	})
	f.l.holders = func(ctx context.Context, port int) ([]LaunchPortHolder, error) {
		select {
		case <-holderDone:
			return nil, nil
		default:
		}
		return []LaunchPortHolder{{Port: port, Pid: holder.Process.Pid, Name: "node"}}, nil
	}
	target := LaunchTarget{Kind: LaunchTargetTrunk}
	plan, _ := f.l.Plan(LaunchPlanRequest{Dir: f.dir, Target: target})
	if len(plan.Holders) != 1 || plan.Holders[0].Pid != holder.Process.Pid {
		t.Fatalf("plan: %+v", plan)
	}
	_, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: target})
	var uiErr *uimsg.Error
	if !errors.As(err, &uiErr) || uiErr.Text.Code != "mission.launch.portsBusy" {
		t.Fatalf("busy ports must block the launch: %v", err)
	}
	select {
	case <-holderDone:
		t.Fatal("the holder was stopped without a confirmation")
	default:
	}
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: target, StopPorts: true}); err != nil {
		t.Fatal(err)
	}
	waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	<-holderDone
}

func TestLaunchServesTheBranchWorktree(t *testing.T) {
	f := makeLaunchFixture(t)
	f.saveRecipe(t, LaunchRecipe{Where: "worktree", Servers: []LaunchRecipeServer{{Id: "web", Run: fmt.Sprintf("exec node %s %d", f.server, f.port), Port: f.port}}})
	tree := filepath.Join(t.TempDir(), "wt")
	gitIn(t, f.dir, "worktree", "add", "-q", tree, "feature/2-upcoming")
	writeLaunchFile(t, tree, "version.txt", "agent work in progress")
	target := LaunchTarget{Kind: LaunchTargetBranch, Branch: "feature/2-upcoming"}
	plan, _ := f.l.Plan(LaunchPlanRequest{Dir: f.dir, Target: target})
	if !plan.Worktree || plan.DirtyCount != 0 {
		t.Fatalf("plan: %+v", plan)
	}
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: target}); err != nil {
		t.Fatal(err)
	}
	state := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	if !state.Worktree || served(t, f.port) != "agent work in progress" || state.Previous != "" {
		t.Fatalf("state: %+v", state)
	}
	if branch := gitIn(t, f.dir, "symbolic-ref", "--short", "HEAD"); branch != "develop" {
		t.Fatalf("the main checkout moved to %s", branch)
	}
}

func TestLaunchAfterRestartFollowsItsServers(t *testing.T) {
	f := makeLaunchFixture(t)
	if _, err := f.l.Start(LaunchStartRequest{Dir: f.dir, Target: LaunchTarget{Kind: LaunchTargetTrunk}}); err != nil {
		t.Fatal(err)
	}
	running := waitLaunch(t, f.l, f.dir, LaunchStateRunning)
	again := MakeLaunches(f.l.baseDir, identityRunner, nil)
	if state, _ := again.State(LaunchDirRequest{Dir: f.dir}); state.State != LaunchStateRunning || state.Id != running.Id {
		t.Fatalf("after a restart: %+v", state)
	}
	if _, err := again.Stop(LaunchDirRequest{Dir: f.dir}); err != nil {
		t.Fatal(err)
	}
	waitGone(t, serverPid(running))
}

func TestLaunchRefusesBadTargets(t *testing.T) {
	l := MakeLaunches(t.TempDir(), plainRunner, nil)
	dir := t.TempDir()
	for _, target := range []LaunchTarget{{Kind: "x"}, {Kind: LaunchTargetPr, Branch: "a"}, {Kind: LaunchTargetBranch, Branch: "--upload-pack=x"}, {Kind: LaunchTargetBranch}} {
		if _, err := l.Start(LaunchStartRequest{Dir: dir, Target: target}); err == nil {
			t.Errorf("%+v must be refused", target)
		}
	}
	_, err := l.Start(LaunchStartRequest{Dir: dir, Target: LaunchTarget{Kind: LaunchTargetBranch, Branch: "feature/1-x"}})
	var uiErr *uimsg.Error
	if !errors.As(err, &uiErr) || uiErr.Text.Code != "mission.launch.noRecipe" {
		t.Fatalf("no recipe: %v", err)
	}
	if _, err := l.ReadLog(LaunchLogRequest{Dir: dir, Step: "../state"}); err == nil {
		t.Fatal("a log outside the logs folder must be refused")
	}
}
