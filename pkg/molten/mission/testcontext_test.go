// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	gnet "github.com/shirou/gopsutil/v4/net"
)

func TestLocalAppTarget(t *testing.T) {
	cases := []struct {
		url  string
		host string
		port int
		ok   bool
	}{
		{"http://localhost:5173/app", "localhost", 5173, true},
		{"http://127.0.0.1:3500", "127.0.0.1", 3500, true},
		{"http://[::1]:8080/", "::1", 8080, true},
		{"https://web.diamondforge.localhost/", "web.diamondforge.localhost", 443, true},
		{"http://notulia.test", "notulia.test", 80, true},
		{"https://github.com/x/y", "", 0, false},
		{"http://192.168.1.10:3000", "", 0, false},
		{"file:///tmp/x.html", "", 0, false},
		{"about:blank", "", 0, false},
		{"http://localhost:99999", "", 0, false},
	}
	for _, c := range cases {
		host, port, ok := LocalAppTarget(c.url)
		if ok != c.ok || (ok && (host != c.host || port != c.port)) {
			t.Errorf("%s: got %q %d %v", c.url, host, port, ok)
		}
	}
}

func TestParsePidLinesAndListeners(t *testing.T) {
	if got := parsePidLines("412\n412\n\n77\nx\n"); !slices.Equal(got, []int32{412, 77}) {
		t.Fatalf("pids: %v", got)
	}
	conns := []gnet.ConnectionStat{
		{Status: "LISTEN", Laddr: gnet.Addr{Port: 5173}, Pid: 10},
		{Status: "LISTEN", Laddr: gnet.Addr{Port: 5173}, Pid: 10},
		{Status: "ESTABLISHED", Laddr: gnet.Addr{Port: 5173}, Pid: 11},
		{Status: "LISTEN", Laddr: gnet.Addr{Port: 3500}, Pid: 12},
		{Status: "LISTEN", Laddr: gnet.Addr{Port: 5173}, Pid: 0},
	}
	if got := listenersOf(conns, 5173); !slices.Equal(got, []int32{10}) {
		t.Fatalf("listeners: %v", got)
	}
}

// The system's own answer: this test process listens on a port, and the lookup finds it.
func TestListeningPidsFindsThisProcess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pids, err := listeningPids(ctx, port)
	if err != nil {
		t.Skipf("the socket table cannot be read here: %v", err)
	}
	if !slices.Contains(pids, int32(os.Getpid())) {
		t.Fatalf("port %d: listeners %v, want %d", port, pids, os.Getpid())
	}
}

// Launch names the processes on its ports through the same lookup as the test context (#1003).
func TestLaunchHoldersUseTheTestContextLookup(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if _, err := listeningPids(ctx, port); err != nil {
		t.Skipf("the socket table cannot be read here: %v", err)
	}
	holders, err := listeningHolders(ctx, port)
	if err != nil {
		t.Fatal(err)
	}
	for _, holder := range holders {
		if holder.Pid == os.Getpid() && holder.Port == port && holder.Name != "" {
			return
		}
	}
	t.Fatalf("port %d: holders %+v, want pid %d with its name", port, holders, os.Getpid())
}

type fakeTestContextHost struct {
	listens int
	pids    []int32
	cwds    map[int32]string
}

func makeFakeTestContexts(panes *Panes, collector *Collector, host *fakeTestContextHost) *TestContexts {
	c := MakeTestContexts(panes, collector)
	c.listeners = func(ctx context.Context, port int) ([]int32, error) {
		host.listens++
		return host.pids, nil
	}
	c.cwd = func(pid int32) string { return host.cwds[pid] }
	c.exe = func(pid int32) string { return "/usr/local/bin/node" }
	return c
}

func TestTestContextOfAPullRequestBranch(t *testing.T) {
	_, clone := makePaneRepo(t)
	gitRun(t, clone, "checkout", "-q", "-b", "feature/12-loader")
	commit(t, clone, "l.txt", "feat(#12): loader")
	os.WriteFile(filepath.Join(clone, "wip.txt"), []byte("wip"), 0644)
	web := filepath.Join(clone, "apps", "web")
	os.MkdirAll(web, 0755)
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{State: GithubStateOk, Prs: json.RawMessage(
		`[{"number":110,"title":"Loader","url":"https://github.com/o/r/pull/110","headRefName":"feature/12-loader","isDraft":true,
		  "statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"FAILURE"}]}]`)}})
	panes := MakePanes(plainRunner, nil, collector)
	host := &fakeTestContextHost{pids: []int32{500, 400}, cwds: map[int32]string{400: t.TempDir(), 500: web}}
	contexts := makeFakeTestContexts(panes, collector, host)

	answer, err := contexts.Get(TestContextRequest{Url: "http://localhost:5173/", WorkspaceDir: clone})
	if err != nil {
		t.Fatal(err)
	}
	if !answer.Known || answer.Pid != 500 || answer.Cwd != web || answer.Process != "node" || answer.Port != 5173 {
		t.Fatalf("the process in a repository wins: %+v", answer)
	}
	if answer.Root != clone || answer.Branch != "feature/12-loader" || answer.Sha == "" || !answer.Dirty || answer.Ticket != 12 {
		t.Fatalf("tree: %+v", answer)
	}
	if answer.Pr == nil || answer.Pr.Number != 110 || !answer.Pr.Draft || answer.Pr.Ci != ReviewCheckFailure {
		t.Fatalf("pr: %+v", answer.Pr)
	}
	if !answer.SameProject || answer.FuturePr || !answer.PrKnown {
		t.Fatalf("flags: %+v", answer)
	}
	other, _ := contexts.Get(TestContextRequest{Url: "http://localhost:5173/", WorkspaceDir: t.TempDir()})
	if other.SameProject {
		t.Fatal("another workspace project was taken for this one")
	}
}

// A worktree's project is its main checkout with symlinks resolved; the collector keeps it under the linked path.
func TestTestContextOfAWorktreeFindsTheLinkedProjectsPrs(t *testing.T) {
	base, clone := makePaneRepo(t)
	tree := filepath.Join(base, "wt")
	gitRun(t, clone, "worktree", "add", "-q", "-b", "feature/12-loader", tree)
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{State: GithubStateOk, Prs: json.RawMessage(
		`[{"number":110,"title":"Loader","url":"u","headRefName":"feature/12-loader"}]`)}})
	host := &fakeTestContextHost{pids: []int32{5}, cwds: map[int32]string{5: tree}}
	contexts := makeFakeTestContexts(MakePanes(plainRunner, nil, collector), collector, host)
	answer, _ := contexts.Get(TestContextRequest{Url: "http://localhost:3950", WorkspaceDir: clone})
	if !answer.Worktree || !answer.SameProject || answer.Pr == nil || answer.Pr.Number != 110 || answer.Pr.Draft {
		t.Fatalf("worktree on a PR branch: %+v", answer)
	}
}

// The developer's case: the checkout serving the app is detached at a PR branch's tip (#961's resolution).
func TestTestContextOfADetachedCheckoutAtAPrBranch(t *testing.T) {
	_, clone := makePaneRepo(t)
	gitRun(t, clone, "checkout", "-q", "-b", "feature/12-loader")
	commit(t, clone, "l.txt", "feat(#12): loader")
	gitRun(t, clone, "push", "-q", "origin", "feature/12-loader")
	gitRun(t, clone, "checkout", "-q", "develop")
	gitRun(t, clone, "branch", "-q", "-D", "feature/12-loader")
	gitRun(t, clone, "fetch", "-q", "origin")
	gitRun(t, clone, "checkout", "-q", "--detach", "origin/feature/12-loader")
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{State: GithubStateOk, Prs: json.RawMessage(
		`[{"number":110,"title":"Loader","url":"u","headRefName":"feature/12-loader"}]`)}})
	host := &fakeTestContextHost{pids: []int32{5}, cwds: map[int32]string{5: clone}}
	contexts := makeFakeTestContexts(MakePanes(plainRunner, nil, collector), collector, host)
	answer, _ := contexts.Get(TestContextRequest{Url: "http://localhost:5173", WorkspaceDir: clone})
	if !answer.Detached || answer.Branch != "feature/12-loader" || answer.Ticket != 12 || answer.Pr == nil || answer.Pr.Number != 110 {
		t.Fatalf("detached at a PR branch: %+v", answer)
	}
}

// A Reviews Launch of a PR whose branch is not on origin detaches at GitHub's pull/<N>/head (#1003): the chip names
// the PR's head branch and the PR, not a bare commit.
func TestTestContextOfACheckoutDetachedAtAPrHead(t *testing.T) {
	base, clone := makePaneRepo(t)
	origin := filepath.Join(base, "origin")
	gitRun(t, origin, "checkout", "-q", "-b", "feature/7-fork")
	commit(t, origin, "f.txt", "feat(#7): from a fork")
	gitRun(t, origin, "update-ref", "refs/pull/7/head", "HEAD")
	gitRun(t, origin, "checkout", "-q", "develop")
	gitRun(t, origin, "branch", "-q", "-D", "feature/7-fork")
	gitRun(t, clone, "fetch", "-q", "--no-tags", "origin", "refs/pull/7/head")
	gitRun(t, clone, "checkout", "-q", "--detach", "FETCH_HEAD")
	out, err := exec.Command("git", "-C", clone, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	sha := strings.TrimSpace(string(out))
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{State: GithubStateOk, Prs: json.RawMessage(
		`[{"number":7,"title":"Fork","url":"u","headRefName":"feature/7-fork","headRefOid":"` + sha + `"}]`)}})
	host := &fakeTestContextHost{pids: []int32{5}, cwds: map[int32]string{5: clone}}
	contexts := makeFakeTestContexts(MakePanes(plainRunner, nil, collector), collector, host)
	answer, _ := contexts.Get(TestContextRequest{Url: "http://localhost:5173", WorkspaceDir: clone})
	if !answer.Detached || answer.Branch != "feature/7-fork" || answer.Ticket != 7 || answer.Pr == nil || answer.Pr.Number != 7 || !answer.SameProject {
		t.Fatalf("detached at pull/7/head: %+v", answer)
	}
}

func TestTestContextFuturePr(t *testing.T) {
	_, clone := makePaneRepo(t)
	collector := MakeCollector(t.TempDir(), plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{State: GithubStateOk,
		Prs: json.RawMessage(`[{"number":7,"title":"Other","url":"u","headRefName":"feature/7-other"}]`)}})
	panes := MakePanes(plainRunner, nil, collector)
	host := &fakeTestContextHost{pids: []int32{9}, cwds: map[int32]string{9: clone}}
	contexts := makeFakeTestContexts(panes, collector, host)

	trunk, _ := contexts.Get(TestContextRequest{Url: "http://localhost:3500"})
	if !trunk.Known || trunk.Branch != "develop" || trunk.FuturePr || trunk.Pr != nil {
		t.Fatalf("the trunk has no future PR: %+v", trunk)
	}
	gitRun(t, clone, "checkout", "-q", "-b", "feature/13-next")
	panes.now = func() time.Time { return time.Now().Add(2 * time.Second) }
	next, _ := contexts.Get(TestContextRequest{Url: "http://localhost:3500", Fresh: true})
	if next.Branch != "feature/13-next" || !next.FuturePr || next.Pr != nil || next.Ticket != 13 {
		t.Fatalf("a work branch without PR: %+v", next)
	}
}

func TestTestContextNeverGuesses(t *testing.T) {
	panes := MakePanes(plainRunner, nil, nil)
	host := &fakeTestContextHost{}
	contexts := makeFakeTestContexts(panes, nil, host)
	if a, _ := contexts.Get(TestContextRequest{Url: "https://example.com"}); a.Known || a.Unknown != TestContextNotLocal {
		t.Fatalf("remote page: %+v", a)
	}
	if a, _ := contexts.Get(TestContextRequest{Url: "http://localhost:4000"}); a.Known || a.Unknown != TestContextNoProcess {
		t.Fatalf("nothing listens: %+v", a)
	}
	host.pids = []int32{21}
	if a, _ := contexts.Get(TestContextRequest{Url: "http://localhost:4001"}); a.Known || a.Unknown != TestContextNoFolder || a.Pid != 21 {
		t.Fatalf("unreadable folder: %+v", a)
	}
	plain := t.TempDir()
	host.cwds = map[int32]string{21: plain}
	if a, _ := contexts.Get(TestContextRequest{Url: "http://localhost:4002"}); a.Known || a.Unknown != TestContextNoRepo || a.Cwd != plain {
		t.Fatalf("folder outside a repository: %+v", a)
	}
}

func TestTestContextReadsListenersAtMostEveryTwoSeconds(t *testing.T) {
	host := &fakeTestContextHost{}
	contexts := makeFakeTestContexts(MakePanes(plainRunner, nil, nil), nil, host)
	clock := time.Now()
	contexts.now = func() time.Time { return clock }
	contexts.Get(TestContextRequest{Url: "http://localhost:5173"})
	contexts.Get(TestContextRequest{Url: "http://localhost:5173/other"})
	if host.listens != 1 {
		t.Fatalf("two asks within the window read the listeners %d times", host.listens)
	}
	contexts.Get(TestContextRequest{Url: "http://localhost:5173", Fresh: true})
	if host.listens != 2 {
		t.Fatalf("a fresh ask did not read again: %d", host.listens)
	}
	clock = clock.Add(testContextListenMaxAge)
	contexts.Get(TestContextRequest{Url: "http://localhost:5173"})
	if host.listens != 3 {
		t.Fatalf("an ask after the window did not read again: %d", host.listens)
	}
}
