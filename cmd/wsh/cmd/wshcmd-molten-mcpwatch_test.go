// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// nextWatch waits for a report matching want; the deadline only bounds a failing run.
func nextWatch(t *testing.T, f *fakeWavesrv, what string, want func(w fakeWatch) bool) fakeWatch {
	t.Helper()
	deadline := time.After(time.Minute)
	for {
		select {
		case w := <-f.watches:
			if want(w) {
				return w
			}
		case <-deadline:
			t.Fatalf("no report: %s", what)
		}
	}
}

// TC-1050-1: each connection reports first, the held watch carries the developer's Reconnect, and after a MoltenTerm
// restart the server comes back and reports by itself, with no call from the agent.
func TestMoltenMcpWatchReportsReconnectsAndComesBack(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.set(func(f *fakeWavesrv) { f.watchAction = agentlinkwire.ActionReconnect })
	f.start()
	b := makeTestMcpBackend(t, f)
	b.Start(context.Background(), mcpbrowser.ClientInfo{Name: "claude-code", Version: "2.1"})

	first := nextWatch(t, f, "the first connection's report", func(w fakeWatch) bool { return w.req.HoldMs == 0 })
	r := first.req
	if first.connNo != 1 || r.Server != agentlinkwire.ServerBrowser || r.Pid != os.Getpid() || r.AgentPid != os.Getppid() ||
		r.ClientName != "claude-code" || r.ClientVersion != "2.1" || r.Token == "" {
		t.Fatalf("report: %+v", first)
	}
	nextWatch(t, f, "the held watch", func(w fakeWatch) bool { return w.connNo == 1 && w.req.HoldMs > 0 })
	// The Reconnect dropped connection 1: connection 2 reports first, then holds its watch.
	nextWatch(t, f, "the new connection's report", func(w fakeWatch) bool { return w.connNo == 2 && w.req.HoldMs == 0 })
	nextWatch(t, f, "the new connection's watch", func(w fakeWatch) bool { return w.connNo == 2 && w.req.HoldMs > 0 })
	if r := b.CallTool(context.Background(), mcpbrowser.ToolTabsContext, nil); r.IsError {
		t.Fatalf("call after Reconnect: %+v", r)
	}
	if hellos, _ := f.counts(); hellos != 2 {
		t.Fatalf("a new session after Reconnect: %d hellos", hellos)
	}

	f.stop()
	waitLinkGone(t, b)
	f.start()
	back := nextWatch(t, f, "the report after the restart", func(w fakeWatch) bool { return w.connNo > 2 && w.req.HoldMs == 0 })
	if back.req.ClientName != "claude-code" {
		t.Fatalf("report after the restart: %+v", back)
	}
}

// A stopped link's refusal reaches the agent as MoltenTerm's own sentence.
func TestMoltenMcpStoppedSentenceIsKept(t *testing.T) {
	err := &moltenMcpLinkError{detail: "x"}
	if got := moltenMcpStartError(moltenMcpBrowserProtocol, err); got == agentlinkwire.ErrStopped {
		t.Fatal("a link error read as a stop")
	}
	wrapped := wrappedError("rpc: " + agentlinkwire.ErrStopped)
	if got := moltenMcpStartError(moltenMcpBrowserProtocol, wrapped); got != agentlinkwire.ErrStopped {
		t.Fatalf("start error: %q", got)
	}
}

type wrappedError string

func (e wrappedError) Error() string { return string(e) }
