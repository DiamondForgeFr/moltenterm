// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const sessionId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

func makeJob(startGen string, reported int, reportedAt int64) *waveobj.Job {
	job := &waveobj.Job{OID: "job1", Connection: "local", JobKind: "shell", AttachedBlockId: "b1", CmdPid: 100, CmdStartTs: 1000, CmdEnv: map[string]string{}, Meta: waveobj.MetaMapType{}}
	if startGen != "" {
		job.CmdEnv[shellutil.MoltenShellGenVarName] = startGen
	}
	if reported > 0 {
		// The store hands meta numbers back as float64.
		job.Meta[ShellGenMetaKey] = float64(reported)
		job.Meta[ShellGenAtMetaKey] = float64(reportedAt)
	}
	return job
}

func TestAssess(t *testing.T) {
	agent := molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Running: true, Started: 5000}
	none := molten.AgentRunInfo{}
	for _, tc := range []struct {
		name      string
		job       *waveobj.Job
		isCommand bool
		run       molten.AgentRunInfo
		current   int
		want      string
	}{
		{"before generations", makeJob("", 0, 0), false, none, 1, ReasonNoGeneration},
		{"before generations, agent", makeJob("", 0, 0), false, agent, 1, ReasonNoGeneration},
		{"current", makeJob("1", 0, 0), false, agent, 1, ""},
		{"block command", makeJob("", 0, 0), true, none, 1, ""},
		{"older, never refreshed", makeJob("1", 0, 0), false, none, 2, ReasonOlderGeneration},
		{"older, refreshable, idle", makeJob("1", 1, 900), false, none, 2, ""},
		{"older, refreshable, agent", makeJob("1", 1, 900), false, agent, 2, ReasonOlderGeneration},
		{"refreshed after the agent started", makeJob("1", 2, 9000), false, agent, 2, ReasonAgentBeforeRefresh},
		{"refreshed before the agent started", makeJob("1", 2, 3000), false, agent, 2, ""},
		{"refreshed, no agent", makeJob("1", 2, 9000), false, none, 2, ""},
	} {
		got, ok := Assess(tc.job, tc.isCommand, tc.run, tc.run.Agent != "", tc.current)
		if got.Reason != tc.want || ok != (tc.want != "") {
			t.Errorf("%s: got %+v %v, want %q", tc.name, got, ok, tc.want)
		}
		if ok && tc.run.Agent != "" && (got.Agent != "claude" || got.AgentName != "Claude Code") {
			t.Errorf("%s: agent %+v", tc.name, got)
		}
	}
	remote := makeJob("", 0, 0)
	remote.Connection = "user@host"
	ended := makeJob("", 0, 0)
	ended.CmdExitTs = 5
	detached := makeJob("", 0, 0)
	detached.AttachedBlockId = ""
	for _, job := range []*waveobj.Job{remote, ended, detached, nil} {
		if _, ok := Assess(job, false, none, false, 1); ok {
			t.Errorf("not a live local shell, marked: %+v", job)
		}
	}
}

// fakeTerm is a terminal whose process table the test drives.
type fakeTerm struct {
	lock     sync.Mutex
	procs    []proctree.Proc
	input    []string
	replaced []string
	run      molten.AgentRunInfo
	session  companion.ResumeSession
	// exitOn: the input that makes the agent exit.
	exitOn     string
	prompts    chan struct{}
	now        time.Time
	replaceErr error
}

func (f *fakeTerm) table() (*proctree.Table, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	return proctree.MakeTable(append([]proctree.Proc(nil), f.procs...)), nil
}

func (f *fakeTerm) send(blockId string, data []byte) error {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.input = append(f.input, string(data))
	if f.exitOn != "" && strings.Join(f.input, "") == f.exitOn {
		// The agent exits; the shell takes its terminal back.
		var kept []proctree.Proc
		for _, p := range f.procs {
			if p.Pid == 100 {
				p.Tpgid = 100
				kept = append(kept, p)
			} else if p.Pid != 200 {
				kept = append(kept, p)
			}
		}
		f.procs = kept
	}
	return nil
}

func (f *fakeTerm) env() Env {
	return Env{
		LoadJob: func(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error) {
			return &waveobj.Block{OID: "b1", JobId: "job1", Meta: waveobj.MetaMapType{}}, makeJob("", 0, 0), nil
		},
		ReadTable: f.table,
		ReadArgs:  func(pid int32) (string, []string) { return "", nil },
		Cwd:       func(pid int32) string { return map[int32]string{100: "/work/shell", 200: "/work/agent"}[pid] },
		AgentRun: func(blockId string) (molten.AgentRunInfo, bool) {
			return f.run, f.run.Agent != ""
		},
		FindSession: func(blockId string, agent string, wait time.Duration) companion.ResumeSession { return f.session },
		SendInput:   f.send,
		Replace: func(ctx context.Context, blockId string, cwd string, notice string) error {
			f.lock.Lock()
			defer f.lock.Unlock()
			if f.replaceErr != nil {
				return f.replaceErr
			}
			f.replaced = append(f.replaced, cwd)
			if f.prompts != nil {
				f.prompts <- struct{}{}
			}
			return nil
		},
		WatchPrompt: func(blockId string) (<-chan struct{}, func()) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.prompts = make(chan struct{}, 1)
			return f.prompts, func() {}
		},
		Sleep: func(d time.Duration) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.now = f.now.Add(d)
		},
		Now: func() time.Time {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.now
		},
	}
}

func shellAt(prompt bool) proctree.Proc {
	tpgid := int32(100)
	if !prompt {
		tpgid = 200
	}
	return proctree.Proc{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: tpgid, Name: "zsh", StartMs: 1000}
}

func TestUpdateIdleShell(t *testing.T) {
	f := &fakeTerm{procs: []proctree.Proc{shellAt(true), {Pid: 150, Ppid: 100, Pgid: 150, Name: "gitstatusd-darwin-arm64"}, {Pid: 151, Ppid: 100, Pgid: 151, Name: "zsh"}}}
	u := MakeUpdater(f.env())
	if out := u.Check(context.Background(), Request{BlockId: "b1"}); out.Status != StatusReady {
		t.Fatalf("check: %+v", out)
	}
	out := u.Run(context.Background(), Request{BlockId: "b1"})
	if out.Status != StatusUpdated || len(f.replaced) != 1 || f.replaced[0] != "/work/shell" || len(f.input) != 0 {
		t.Fatalf("run: %+v, replaced %v, input %q", out, f.replaced, f.input)
	}
}

func TestUpdateRefusesBusyShell(t *testing.T) {
	for _, tc := range []struct {
		name  string
		procs []proctree.Proc
		want  string
	}{
		{"foreground program", []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "sleep"}}, "sleep"},
		{"background job", []proctree.Proc{shellAt(true), {Pid: 300, Ppid: 100, Pgid: 300, Tpgid: 100, Name: "npm"}}, "npm"},
		{"job in a subshell", []proctree.Proc{shellAt(true), {Pid: 300, Ppid: 100, Pgid: 300, Name: "zsh"}, {Pid: 301, Ppid: 300, Pgid: 300, Name: "rsync"}}, "rsync"},
	} {
		f := &fakeTerm{procs: tc.procs}
		u := MakeUpdater(f.env())
		out := u.Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
		if out.Status != StatusBusy || out.Program != tc.want || !strings.Contains(out.Message, "Finish or stop "+tc.want) {
			t.Errorf("%s: %+v", tc.name, out)
		}
		if len(f.replaced) != 0 || len(f.input) != 0 {
			t.Errorf("%s: touched the terminal: %v %q", tc.name, f.replaced, f.input)
		}
	}
}

func agentTerm() *fakeTerm {
	return &fakeTerm{
		procs:  []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "claude", StartMs: 4000}},
		run:    molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Running: true, State: molten.AgentStateIdle},
		exitOn: "/exit\r",
	}
}

func TestUpdateRestartsAgentOnItsSession(t *testing.T) {
	f := agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkHook, Sure: true}
	u := MakeUpdater(f.env())
	if out := u.Run(context.Background(), Request{BlockId: "b1"}); out.Status != StatusNeedConfirm || out.AgentName != "Claude Code" || len(f.input) != 0 {
		t.Fatalf("unconfirmed: %+v %q", out, f.input)
	}
	out := u.Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	want := "claude --resume " + sessionId
	if out.Status != StatusUpdated || out.Command != want || out.Guessed {
		t.Fatalf("run: %+v", out)
	}
	if strings.Join(f.input, "|") != "/exit|\r|"+want+"\r" {
		t.Errorf("typed %q", f.input)
	}
	if len(f.replaced) != 1 || f.replaced[0] != "/work/agent" {
		t.Errorf("replaced in %v, want the agent's folder", f.replaced)
	}
}

func TestUpdateGuessedSession(t *testing.T) {
	f := agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkGuessed}
	out := MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	if out.Status != StatusUpdated || out.Command != "claude --continue" || !out.Guessed || !strings.Contains(out.Message, "could not tell") {
		t.Fatalf("run: %+v", out)
	}
}

func TestUpdateLeavesAWorkingOrStuckAgent(t *testing.T) {
	f := agentTerm()
	f.run.State = molten.AgentStateWorking
	out := MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	if out.Status != StatusAgentBusy || len(f.input) != 0 {
		t.Fatalf("working: %+v %q", out, f.input)
	}

	f = agentTerm()
	f.exitOn = "never"
	out = MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	if out.Status != StatusAgentStuck || len(f.replaced) != 0 {
		t.Fatalf("stuck: %+v replaced %v", out, f.replaced)
	}
	if tbl, _ := f.table(); tbl.Get(200) == nil {
		t.Errorf("the agent's process was touched")
	}
}

func TestResumeCommand(t *testing.T) {
	codex := agentcontinuity.Find("codex")
	path := "/h/.codex/sessions/2026/10/08/rollout-2026-10-08T10-00-00-" + sessionId + ".jsonl"
	if got, guessed := ResumeCommand(codex, "codex", companion.ResumeSession{Path: path, Sure: true}); got != "codex resume "+sessionId || guessed {
		t.Errorf("codex sure: %q %v", got, guessed)
	}
	if got, guessed := ResumeCommand(codex, "codex", companion.ResumeSession{}); got != "codex resume --last" || !guessed {
		t.Errorf("codex unknown: %q %v", got, guessed)
	}
}
