// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// A helper server or sleeper started by the real stop test ends by itself after this, should the test die first.
const servedHelperLife = 3 * time.Minute

func TestParseLsofSockets(t *testing.T) {
	t.Parallel()
	out := "p412\nf12\nn*:5173\nf13\nn[::1]:5174\nf14\nn192.168.1.4:9000\np77\nf4\nn127.0.0.1:3500\nf5\nn127.0.0.1:3500\n" +
		"pnope\nn*:1\np0\nn*:2\np88\nf3\nn[::]:8080\nnbroken\nn*:99999\n"
	got := parseLsofSockets(out)
	want := []listenSocket{{412, 5173}, {412, 5174}, {77, 3500}, {88, 8080}}
	if !slices.Equal(got, want) {
		t.Fatalf("sockets:\n got %v\nwant %v", got, want)
	}
}

func TestSocketsOfTheSystemTable(t *testing.T) {
	t.Parallel()
	conns := []gnet.ConnectionStat{
		{Status: "LISTEN", Laddr: gnet.Addr{IP: "0.0.0.0", Port: 5173}, Pid: 10},
		{Status: "LISTEN", Laddr: gnet.Addr{IP: "::1", Port: 5173}, Pid: 10},
		{Status: "LISTEN", Laddr: gnet.Addr{IP: "10.0.0.2", Port: 5174}, Pid: 11},
		{Status: "ESTABLISHED", Laddr: gnet.Addr{IP: "127.0.0.1", Port: 3000}, Pid: 12},
		{Status: "LISTEN", Laddr: gnet.Addr{IP: "127.0.0.1", Port: 3000}, Pid: 0},
		{Status: "LISTEN", Laddr: gnet.Addr{IP: "::", Port: 8080}, Pid: 13},
	}
	if got := socketsOf(conns); !slices.Equal(got, []listenSocket{{10, 5173}, {13, 8080}}) {
		t.Fatalf("sockets: %v", got)
	}
}

// fakeServedHost is the system the version card reads and signals: listeners, folders, the process table.
type fakeServedHost struct {
	sockets  []listenSocket
	cwds     map[int32]string
	procs    []proctree.Proc
	agents   map[int32]string
	known    []string
	dead     map[int32]bool
	stubborn map[int32]bool
	signals  []string
	onSignal func(pid int32)
}

func (h *fakeServedHost) listening() []listenSocket {
	rtn := []listenSocket{}
	for _, s := range h.sockets {
		if !h.dead[s.pid] {
			rtn = append(rtn, s)
		}
	}
	return rtn
}

func makeFakeServed(panes *Panes, host *fakeServedHost) *TestContexts {
	if host.dead == nil {
		host.dead = map[int32]bool{}
	}
	c := MakeTestContexts(panes, nil)
	c.sockets = func(ctx context.Context) ([]listenSocket, error) { return host.listening(), nil }
	c.listeners = func(ctx context.Context, port int) ([]int32, error) {
		var pids []int32
		for _, s := range host.listening() {
			if s.port == port && !slices.Contains(pids, s.pid) {
				pids = append(pids, s.pid)
			}
		}
		return pids, nil
	}
	c.cwd = func(pid int32) string { return host.cwds[pid] }
	c.exe = func(pid int32) string { return "/opt/bin/node" }
	c.procs = func() (*proctree.Table, error) {
		live := []proctree.Proc{}
		for _, p := range host.procs {
			if !host.dead[p.Pid] {
				live = append(live, p)
			}
		}
		return proctree.MakeTable(live), nil
	}
	c.signal = func(pid int32, kill bool) error {
		if kill {
			host.signals = append(host.signals, fmt.Sprintf("kill:%d", pid))
		} else {
			host.signals = append(host.signals, fmt.Sprintf("term:%d", pid))
		}
		if kill || !host.stubborn[pid] {
			host.dead[pid] = true
		}
		if host.onSignal != nil {
			host.onSignal(pid)
		}
		return nil
	}
	c.agentOf = func(p *proctree.Proc) string {
		if p == nil {
			return ""
		}
		return host.agents[p.Pid]
	}
	c.known = func(ctx context.Context) ([]string, error) { return host.known, nil }
	c.self = 1000
	c.stopGrace = time.Minute
	return c
}

type servedFixture struct {
	clone, wtA, wtB, other, plain string
}

// Two worktrees of one synthetic project and its main checkout, another project, a folder outside any repository; the
// folders as the system gives them, symlinks resolved.
func makeServedFixture(t *testing.T) servedFixture {
	base, clone := makePaneRepo(t)
	f := servedFixture{clone: realPath(clone), wtA: filepath.Join(realPath(base), "wt-a"), wtB: filepath.Join(realPath(base), "wt-b")}
	gitRun(t, clone, "worktree", "add", "-q", "-b", "feature/1-a", f.wtA)
	gitRun(t, clone, "worktree", "add", "-q", "-b", "feature/2-b", f.wtB)
	os.MkdirAll(filepath.Join(f.wtA, "web"), 0755)
	_, other := makePaneRepo(t)
	f.other = realPath(other)
	f.plain = realPath(t.TempDir())
	return f
}

// The processes of the fixture: 101 serves wt-a's web folder on two ports with a worker 102 on the first, 103 is what
// 101 started there, 104 what it started outside, 105 a shell in wt-a it did not start; 201 serves wt-b, 301 the main
// checkout, 401 another project, 501 a folder outside any repository, 601 is a coding agent's own port in wt-a; 1000 is
// wavesrv and 999 the window above it.
func servedHost(f servedFixture) *fakeServedHost {
	return &fakeServedHost{
		sockets: []listenSocket{
			{101, 5173}, {101, 5174}, {102, 5173}, {201, 5180}, {301, 3000}, {401, 4000}, {501, 8080}, {601, 7777},
			{1000, 9000}, {999, 9001},
		},
		cwds: map[int32]string{
			101: filepath.Join(f.wtA, "web"), 102: f.wtA, 103: f.wtA, 104: f.plain, 105: f.wtA,
			201: f.wtB, 301: f.clone, 401: f.other, 501: f.plain, 601: f.wtA, 1000: f.clone, 999: f.clone,
		},
		procs: []proctree.Proc{
			{Pid: 999, Ppid: 1, StartMs: 1}, {Pid: 1000, Ppid: 999, StartMs: 2},
			{Pid: 90, Ppid: 1, StartMs: 3}, {Pid: 101, Ppid: 90, StartMs: 4}, {Pid: 102, Ppid: 101, StartMs: 5},
			{Pid: 103, Ppid: 101, StartMs: 6}, {Pid: 104, Ppid: 101, StartMs: 7}, {Pid: 105, Ppid: 90, StartMs: 8},
			{Pid: 201, Ppid: 1, StartMs: 9}, {Pid: 301, Ppid: 1, StartMs: 10}, {Pid: 401, Ppid: 1, StartMs: 11},
			{Pid: 501, Ppid: 1, StartMs: 12}, {Pid: 601, Ppid: 90, StartMs: 13},
		},
		agents: map[int32]string{601: "claude"},
		known:  []string{f.clone},
	}
}

func TestServedVersionsGroupsTheCheckouts(t *testing.T) {
	t.Parallel()
	f := makeServedFixture(t)
	contexts := makeFakeServed(MakePanes(withoutGh, nil, nil), servedHost(f))
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(f.clone, linked); err != nil {
		t.Fatal(err)
	}
	answer, err := contexts.Versions(ServedVersionsRequest{WorkspaceDirs: []string{linked}})
	if err != nil || answer.Unknown != "" {
		t.Fatalf("versions: %v %+v", err, answer)
	}
	roots := []string{}
	for _, v := range answer.Versions {
		roots = append(roots, v.Root)
	}
	if len(roots) != 4 || !slices.Contains(roots, f.other) || slices.Contains(roots, f.plain) {
		t.Fatalf("the checkouts served, nothing outside a repository, nothing of MoltenTerm's own: %q", roots)
	}
	var ours []ServedVersion
	for _, v := range answer.Versions {
		if v.Project == f.clone {
			ours = append(ours, v)
		}
	}
	if len(ours) != 3 || ours[0].Root != f.clone || ours[0].Worktree || ours[1].Branch != "feature/1-a" || ours[2].Branch != "feature/2-b" {
		t.Fatalf("the project's versions, its main checkout first: %+v", ours)
	}
	a := ours[1]
	if !a.Worktree || a.Ticket != 1 || a.ProjectDir != linked || !slices.Equal(a.Servers, []ServedServer{{5173, 101, "node"}, {5174, 101, "node"}}) {
		t.Fatalf("wt-a: one server per port, the parent naming a port its worker shares: %+v", a)
	}
	for _, v := range answer.Versions {
		if v.Root == f.other && v.ProjectDir != "" {
			t.Fatalf("another project names no workspace project: %+v", v)
		}
	}
}

func TestServedVersionsSaysWhenTheListenersCannotBeRead(t *testing.T) {
	t.Parallel()
	contexts := makeFakeServed(MakePanes(withoutGh, nil, nil), &fakeServedHost{})
	contexts.sockets = func(ctx context.Context) ([]listenSocket, error) { return nil, fmt.Errorf("no socket table") }
	answer, err := contexts.Versions(ServedVersionsRequest{})
	if err != nil || answer.Unknown != ServedVersionsUnreadable || len(answer.Versions) != 0 {
		t.Fatalf("unreadable: %v %+v", err, answer)
	}
}

func TestServedStopRefuses(t *testing.T) {
	t.Parallel()
	f := makeServedFixture(t)
	host := servedHost(f)
	contexts := makeFakeServed(MakePanes(withoutGh, nil, nil), host)
	cases := []struct {
		name   string
		req    ServedStopRequest
		code   string
		folder string
	}{
		{"wavesrv", ServedStopRequest{Port: 9000, Pid: 1000, Root: f.clone}, ServedStopRefusedSelf, ""},
		{"the window above it", ServedStopRequest{Port: 9001, Pid: 999, Root: f.clone}, ServedStopRefusedSelf, ""},
		{"a process no longer on the port", ServedStopRequest{Port: 5180, Pid: 101, Root: f.wtA}, ServedStopRefusedGone, ""},
		{"a folder outside any repository", ServedStopRequest{Port: 8080, Pid: 501, Root: f.plain}, ServedStopRefusedNoRepo, f.plain},
		{"another checkout than the card's", ServedStopRequest{Port: 5180, Pid: 201, Root: f.wtA}, ServedStopRefusedMoved, f.wtB},
		{"a project not linked to MoltenTerm", ServedStopRequest{Port: 4000, Pid: 401, Root: f.other}, ServedStopRefusedUnknownProject, f.other},
		{"a coding agent's own port", ServedStopRequest{Port: 7777, Pid: 601, Root: f.wtA}, ServedStopRefusedAgent, ""},
	}
	for _, c := range cases {
		result, err := contexts.Stop(c.req)
		if err != nil || result.Refused != c.code || result.Folder != c.folder || len(result.Stopped) != 0 {
			t.Errorf("%s: %v %+v", c.name, err, result)
		}
		if c.code == ServedStopRefusedAgent && result.Agent != molten.AgentDisplayName("claude") {
			t.Errorf("the refusal names the agent: %+v", result)
		}
	}
	if len(host.signals) != 0 {
		t.Fatalf("a refused stop signalled: %v", host.signals)
	}
	for _, req := range []ServedStopRequest{{Port: 0, Pid: 101, Root: f.wtA}, {Port: 5173, Pid: 0, Root: f.wtA}, {Port: 5173, Pid: 101, Root: "wt-a"}} {
		if _, err := contexts.Stop(req); err == nil {
			t.Errorf("a malformed stop was taken: %+v", req)
		}
	}
}

func TestServedStopTargetsOnlyTheCheckoutsServer(t *testing.T) {
	t.Parallel()
	f := makeServedFixture(t)
	host := servedHost(f)
	contexts := makeFakeServed(MakePanes(withoutGh, nil, nil), host)
	result, err := contexts.Stop(ServedStopRequest{Port: 5173, Pid: 101, Root: f.wtA})
	if err != nil || result.Refused != "" || result.Still {
		t.Fatalf("stop: %v %+v", err, result)
	}
	if want := []string{"term:101", "term:102", "term:103"}; !slices.Equal(host.signals, want) {
		t.Fatalf("signals: %v, want %v: the listeners in the checkout and what they started there, nothing else", host.signals, want)
	}
	if !slices.Equal(result.Stopped, []int32{101, 102, 103}) {
		t.Fatalf("stopped: %v", result.Stopped)
	}
	after, _ := contexts.Versions(ServedVersionsRequest{})
	for _, v := range after.Versions {
		if v.Root == f.wtA {
			t.Fatalf("the stopped version is still listed: %+v", v)
		}
	}
	if len(after.Versions) != 3 {
		t.Fatalf("the list updates without the stopped version only: %+v", after.Versions)
	}
}

func TestServedStopKillsWhatIgnoresTheSignalAndSaysWhenItCameBack(t *testing.T) {
	t.Parallel()
	f := makeServedFixture(t)
	host := servedHost(f)
	host.stubborn = map[int32]bool{201: true}
	contexts := makeFakeServed(MakePanes(withoutGh, nil, nil), host)
	contexts.stopGrace = 0
	result, err := contexts.Stop(ServedStopRequest{Port: 5180, Pid: 201, Root: f.wtB})
	if err != nil || result.Still || !slices.Equal(host.signals, []string{"term:201", "kill:201"}) {
		t.Fatalf("a process ignoring SIGTERM is killed after the grace: %v %+v %v", err, result, host.signals)
	}
	// A supervisor that starts the server again: the stop says the port is served again.
	host.signals = nil
	host.onSignal = func(pid int32) {
		if pid == 301 {
			host.sockets = append(host.sockets, listenSocket{302, 3000})
		}
	}
	host.cwds[302] = f.clone
	again, err := contexts.Stop(ServedStopRequest{Port: 3000, Pid: 301, Root: f.clone})
	if err != nil || !again.Still || !slices.Equal(again.Stopped, []int32{301}) {
		t.Fatalf("restarted by its supervisor: %v %+v", err, again)
	}
}

// The helper processes of the real stop test: a server listening on a port of its own, which can start a child, and
// a sleeper. Each writes what the test needs in its file and ends by itself after servedHelperLife.
func TestServedHelperProcess(t *testing.T) {
	t.Parallel()
	mode := os.Getenv("MOLTEN_SERVED_HELPER")
	if mode == "" {
		return
	}
	// SIGTERM ends the helper as a server ends: its test returns, so TestMain removes its own temporary folders.
	terminated := make(chan os.Signal, 1)
	signal.Notify(terminated, syscall.SIGTERM)
	out := os.Getenv("MOLTEN_SERVED_OUT")
	if mode == "serve" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		info := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
		if os.Getenv("MOLTEN_SERVED_CHILD") != "" {
			child := exec.Command(os.Args[0], "-test.run=^TestServedHelperProcess$")
			child.Env = append(os.Environ(), "MOLTEN_SERVED_HELPER=sleep", "MOLTEN_SERVED_CHILD=")
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			info += " " + strconv.Itoa(child.Process.Pid)
		}
		if err := os.WriteFile(out+".tmp", []byte(info), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(out+".tmp", out); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-terminated:
	case <-time.After(servedHelperLife):
	}
}

type servedHelper struct {
	pid      int32
	port     int
	child    int32
	childAt  int64
	finished chan struct{}
}

// startServedHelper starts a helper server in dir and waits for its port; the cleanup ends it and its child, checking
// the child is still the process it started.
func startServedHelper(t *testing.T, dir string, withChild bool) *servedHelper {
	out := filepath.Join(t.TempDir(), "helper")
	cmd := exec.Command(os.Args[0], "-test.run=^TestServedHelperProcess$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "MOLTEN_SERVED_HELPER=serve", "MOLTEN_SERVED_OUT="+out)
	if withChild {
		cmd.Env = append(cmd.Env, "MOLTEN_SERVED_CHILD=1")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	h := &servedHelper{pid: int32(cmd.Process.Pid), finished: make(chan struct{})}
	go func() {
		cmd.Wait()
		close(h.finished)
	}()
	t.Cleanup(func() {
		cmd.Process.Kill()
		<-h.finished
		if h.child <= 0 {
			return
		}
		if table, err := proctree.Read(); err == nil && table.Same(h.child, h.childAt) {
			if p, err := os.FindProcess(int(h.child)); err == nil {
				p.Kill()
			}
		}
	})
	deadline := time.Now().Add(time.Minute)
	for {
		data, err := os.ReadFile(out)
		if err == nil {
			fields := strings.Fields(string(data))
			h.port, _ = strconv.Atoi(fields[0])
			if len(fields) > 1 {
				child, _ := strconv.Atoi(fields[1])
				h.child = int32(child)
			}
			break
		}
		select {
		case <-h.finished:
			t.Fatal("the helper server ended before listening")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the helper server did not listen within a minute")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if h.child > 0 {
		if table, err := proctree.Read(); err == nil {
			if p := table.Get(h.child); p != nil {
				h.childAt = p.StartMs
			}
		}
	}
	return h
}

// The acceptance case (#2326 AC2): two worktrees of one project serve; stopping the first stops its server and the
// process it started, the second keeps serving, and the versions list follows.
func TestServedStopStopsOnlyThatWorktreesServer(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("the helpers' folders and process tree are read on macOS and Linux")
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen: %v", err)
	}
	probeCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
	_, err = listeningPids(probeCtx, probe.Addr().(*net.TCPAddr).Port)
	cancel()
	probe.Close()
	if err != nil {
		t.Skipf("the socket table cannot be read here: %v", err)
	}
	if _, err := proctree.Read(); err != nil {
		t.Skipf("the process table cannot be read here: %v", err)
	}
	f := makeServedFixture(t)
	a := startServedHelper(t, f.wtA, true)
	b := startServedHelper(t, f.wtB, false)
	contexts := MakeTestContexts(MakePanes(withoutGh, nil, nil), nil)
	contexts.known = func(ctx context.Context) ([]string, error) { return []string{f.clone}, nil }
	contexts.stopGrace = time.Minute
	contexts.sockets = func(ctx context.Context) ([]listenSocket, error) {
		all, err := listeningSockets(ctx)
		return slices.DeleteFunc(all, func(s listenSocket) bool { return s.pid != a.pid && s.pid != b.pid }), err
	}
	before, err := contexts.Versions(ServedVersionsRequest{Fresh: true})
	if err != nil || len(before.Versions) != 2 || before.Versions[0].Branch != "feature/1-a" || before.Versions[1].Branch != "feature/2-b" ||
		before.Versions[0].Servers[0].Port != a.port || before.Versions[1].Servers[0].Pid != b.pid {
		t.Fatalf("two worktrees of one project serve: %v %+v", err, before)
	}
	result, err := contexts.Stop(ServedStopRequest{Port: a.port, Pid: a.pid, Root: f.wtA})
	if err != nil || result.Refused != "" || result.Still || !slices.Contains(result.Stopped, a.pid) || !slices.Contains(result.Stopped, a.child) {
		t.Fatalf("stop: %v %+v (server %d, child %d)", err, result, a.pid, a.child)
	}
	table, err := proctree.Read()
	if err != nil {
		t.Fatal(err)
	}
	if table.Same(a.child, a.childAt) {
		t.Fatal("the process the server started still runs")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pids, err := listeningPids(ctx, b.port)
	if err != nil || !slices.Contains(pids, b.pid) {
		t.Fatalf("the other worktree's server stopped too: %v %v", err, pids)
	}
	after, err := contexts.Versions(ServedVersionsRequest{Fresh: true})
	if err != nil || len(after.Versions) != 1 || after.Versions[0].Root != f.wtB {
		t.Fatalf("the list after the stop: %v %+v", err, after)
	}
}
