// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

// The machine's own login time would mark the fixtures' jobs (started at 1000 ms): every test starts from an unknown
// login, and the tests of #1194 set theirs.
func TestMain(m *testing.M) {
	LoginStartMs = func() int64 { return 0 }
	os.Exit(m.Run())
}

func withLoginStart(t *testing.T, ms int64) {
	prev := LoginStartMs
	LoginStartMs = func() int64 { return ms }
	t.Cleanup(func() { LoginStartMs = prev })
}

func TestAssessPreviousLogin(t *testing.T) {
	current := shellutil.MoltenShellGeneration
	upToDate := makeJob("", current, 1000)

	withLoginStart(t, 5000)
	term, ok := Assess(upToDate, false, molten.AgentRunInfo{}, false, current)
	if !ok || term.Reason != ReasonPreviousLogin || term.BlockId != "b1" {
		t.Fatalf("a current shell started before the login: got %+v %v", term, ok)
	}
	run := molten.AgentRunInfo{Agent: "claude", Running: true, Started: 2000}
	term, ok = Assess(upToDate, false, run, true, current)
	if !ok || term.Reason != ReasonPreviousLogin || term.Agent != "claude" || term.AgentName == "" {
		t.Fatalf("an agent in a shell from before the login: got %+v %v", term, ok)
	}
	if _, ok := Assess(upToDate, true, run, true, current); ok {
		t.Fatalf("a block's command is never assessed")
	}
	ssh := makeJob("", current, 1000)
	ssh.Connection = "user@host"
	if _, ok := Assess(ssh, false, molten.AgentRunInfo{}, false, current); ok {
		t.Fatalf("an SSH shell is never marked")
	}

	withLoginStart(t, 500)
	if _, ok := Assess(upToDate, false, molten.AgentRunInfo{}, false, current); ok {
		t.Fatalf("a shell started after the login is not marked")
	}

	withLoginStart(t, 0)
	if _, ok := Assess(upToDate, false, molten.AgentRunInfo{}, false, current); ok {
		t.Fatalf("an unknown login marks nothing")
	}
}

func TestStartedBeforeLogin(t *testing.T) {
	job := makeJob("", 0, 0)
	job.CmdStartTs = 0
	if StartedBeforeLogin(job, 5000) {
		t.Fatalf("a job without a start time is not marked")
	}
	if StartedBeforeLogin(nil, 5000) {
		t.Fatalf("no job, no mark")
	}
	job.CmdStartTs = 5000
	if StartedBeforeLogin(job, 5000) {
		t.Fatalf("started at the login itself is not before it")
	}
}

func TestPreviousLoginNotice(t *testing.T) {
	list := []OutdatedTerminal{{BlockId: "a", Reason: ReasonPreviousLogin}, {BlockId: "b", Reason: ReasonNoGeneration},
		{BlockId: "c", Reason: ReasonPreviousLogin}}
	if n := PreviousLoginCount(list); n != 2 {
		t.Fatalf("count %d", n)
	}
	notice := PreviousLoginNotice(2)
	if notice.Source != "sessions" || notice.Kind != "warning" || notice.TitleText == nil || notice.MessageText == nil {
		t.Fatalf("notice %+v", notice)
	}
	if len(notice.Actions) != 1 || notice.Actions[0].View != sessionsView || notice.Actions[0].LabelText == nil {
		t.Fatalf("actions %+v", notice.Actions)
	}
	s := &service{}
	if s.swapToldLogin(2) != 2 || s.swapToldLogin(2) != 0 || s.swapToldLogin(1) != 0 || s.swapToldLogin(3) != 3 {
		t.Fatalf("a notice is posted only when more terminals lost the network than last told")
	}
}

// The real reading, on a machine with a console login: a time in the past, never in the future.
func TestReadLoginStartMs(t *testing.T) {
	ms := readLoginStartMs()
	if ms < 0 {
		t.Fatalf("login start %d", ms)
	}
	t.Logf("console login: %d", ms)
}
