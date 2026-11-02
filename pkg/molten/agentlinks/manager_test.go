// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlinks

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

type fakeEnv struct {
	lock      sync.Mutex
	runs      map[string]molten.AgentRunInfo
	dead      map[int]bool
	stops     map[string][]string
	published []agentlinkwire.BlockLinks
}

func makeFakeEnv() *fakeEnv {
	return &fakeEnv{runs: map[string]molten.AgentRunInfo{}, dead: map[int]bool{}, stops: map[string][]string{}}
}

func (e *fakeEnv) VerifyToken(token string) (string, error) {
	if strings.HasPrefix(token, "tok-") {
		return strings.TrimPrefix(token, "tok-"), nil
	}
	return "", errors.New("bad token")
}

func (e *fakeEnv) Run(blockId string) (molten.AgentRunInfo, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	run, ok := e.runs[blockId]
	return run, ok
}

func (e *fakeEnv) Runs() []molten.AgentRunInfo {
	e.lock.Lock()
	defer e.lock.Unlock()
	var rtn []molten.AgentRunInfo
	for _, run := range e.runs {
		rtn = append(rtn, run)
	}
	return rtn
}

func (e *fakeEnv) Alive(pid int) bool {
	e.lock.Lock()
	defer e.lock.Unlock()
	return pid > 0 && !e.dead[pid]
}

func (e *fakeEnv) kill(pid int) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.dead[pid] = true
}

func (e *fakeEnv) Stops(blockId string) []string {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]string{}, e.stops[blockId]...)
}

func (e *fakeEnv) SetStops(blockId string, keys []string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.stops[blockId] = keys
}

func (e *fakeEnv) Publish(state agentlinkwire.BlockLinks) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.published = append(e.published, state)
}

func (e *fakeEnv) Version() string {
	return "1.0.0"
}

func terminal(blockId string, source string) localroute.Caller {
	return localroute.Caller{Source: source, IsLocalTerminal: true, BlockId: blockId}
}

var window = localroute.Caller{Source: "tab:window", IsWindow: true}

func report(blockId string, server string, pid int, agentPid int, client string) agentlinkwire.WatchRequest {
	return agentlinkwire.WatchRequest{Token: "tok-" + blockId, Server: server, Pid: pid, AgentPid: agentPid,
		ClientName: client, Version: "1.0.0"}
}

func mustWatch(t *testing.T, m *Manager, caller localroute.Caller, req agentlinkwire.WatchRequest) {
	t.Helper()
	if _, err := m.Watch(context.Background(), caller, req); err != nil {
		t.Fatalf("watch: %v", err)
	}
}

func linkOf(t *testing.T, state agentlinkwire.BlockLinks, key string) (agentlinkwire.AgentInfo, agentlinkwire.LinkInfo) {
	t.Helper()
	for _, agent := range state.Agents {
		for _, l := range agent.Links {
			if l.Key == key {
				return agent, l
			}
		}
	}
	t.Fatalf("no link %s in %+v", key, state)
	return agentlinkwire.AgentInfo{}, agentlinkwire.LinkInfo{}
}

// Two agents in one terminal: the detected one (Claude Code, pid 100) and another whose MCP client names Codex.
func TestTwoAgentsInOneTerminal(t *testing.T) {
	env := makeFakeEnv()
	env.runs["b1"] = molten.AgentRunInfo{BlockId: "b1", Agent: molten.AgentIdClaude, Running: true, Pid: 100, FirstName: "Valentin",
		Settings: molten.AgentSettings{ModelName: "Opus"}}
	m := MakeManager(env)
	mustWatch(t, m, terminal("b1", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "claude-code"))
	mustWatch(t, m, terminal("b1", "proc:b"), report("b1", agentlinkwire.ServerBrowser, 2001, 200, "codex-mcp-client"))

	state := m.Snapshot("b1")
	if len(state.Agents) != 2 {
		t.Fatalf("agents: %+v", state.Agents)
	}
	main, l := linkOf(t, state, LinkKey(agentlinkwire.ServerBrowser, 1001))
	if !main.Main || main.FirstName != "Valentin" || main.Model != "Opus" || l.State != agentlinkwire.StateConnected || !l.Controllable {
		t.Fatalf("main agent: %+v %+v", main, l)
	}
	other, _ := linkOf(t, state, LinkKey(agentlinkwire.ServerBrowser, 2001))
	if other.Main || other.Agent != molten.AgentIdCodex || other.AgentName != "Codex" || other.ClientName != "codex-mcp-client" {
		t.Fatalf("other agent: %+v", other)
	}
}

func TestStatesFromRouteAndProcesses(t *testing.T) {
	env := makeFakeEnv()
	m := MakeManager(env)
	mustWatch(t, m, terminal("b1", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "claude-code"))
	key := LinkKey(agentlinkwire.ServerBrowser, 1001)

	m.RouteDown("proc:a")
	if _, l := linkOf(t, m.Snapshot("b1"), key); l.State != agentlinkwire.StateReconnecting || l.Controllable {
		t.Fatalf("route down, server alive: %+v", l)
	}
	env.kill(1001)
	if _, l := linkOf(t, m.Snapshot("b1"), key); l.State != agentlinkwire.StateBroken {
		t.Fatalf("server gone, agent alive: %+v", l)
	}
	mustWatch(t, m, terminal("b1", "proc:c"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "claude-code"))
	if _, l := linkOf(t, m.Snapshot("b1"), key); l.State != agentlinkwire.StateConnected {
		t.Fatalf("back: %+v", l)
	}
	m.RouteDown("proc:c")
	env.kill(100)
	if state := m.Snapshot("b1"); len(state.Agents) != 0 {
		t.Fatalf("the agent is gone, its link too: %+v", state)
	}
}

// The agent restarts its server (/mcp → Reconnect): the new one replaces the dead one in the menu.
func TestRestartedServerReplacesTheDeadOne(t *testing.T) {
	env := makeFakeEnv()
	m := MakeManager(env)
	mustWatch(t, m, terminal("b1", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "claude-code"))
	m.RouteDown("proc:a")
	env.kill(1001)
	mustWatch(t, m, terminal("b1", "proc:b"), report("b1", agentlinkwire.ServerBrowser, 1002, 100, "claude-code"))
	state := m.Snapshot("b1")
	if len(state.Agents) != 1 || len(state.Agents[0].Links) != 1 || state.Agents[0].Links[0].Pid != 1002 {
		t.Fatalf("after the restart: %+v", state)
	}
}

func TestOutdatedServer(t *testing.T) {
	env := makeFakeEnv()
	m := MakeManager(env)
	req := report("b1", agentlinkwire.ServerReview, 1001, 100, "x")
	req.Version = "0.9.0"
	req.UpdateBlocked = "it is writable by other accounts"
	mustWatch(t, m, terminal("b1", "proc:a"), req)
	_, l := linkOf(t, m.Snapshot("b1"), LinkKey(agentlinkwire.ServerReview, 1001))
	if !l.Outdated || l.UpdateBlocked == "" {
		t.Fatalf("outdated: %+v", l)
	}
}

func TestStopGatesAndSurvivesARestart(t *testing.T) {
	env := makeFakeEnv()
	m := MakeManager(env)
	var stopped []string
	m.OnStop(func(source string) { stopped = append(stopped, source) })
	mustWatch(t, m, terminal("b1", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "c"))
	key := LinkKey(agentlinkwire.ServerBrowser, 1001)

	if err := m.Control(terminal("b1", "proc:a"), agentlinkwire.ControlRequest{BlockId: "b1", LinkKey: key, Action: agentlinkwire.ActionStop}); err == nil {
		t.Fatal("a terminal stopped a link")
	}
	if err := m.Gate("proc:a"); err != nil {
		t.Fatalf("gated before the stop: %v", err)
	}
	if err := m.Control(window, agentlinkwire.ControlRequest{BlockId: "b1", LinkKey: key, Action: agentlinkwire.ActionStop}); err != nil {
		t.Fatal(err)
	}
	if err := m.Gate("proc:a"); err == nil || err.Error() != agentlinkwire.ErrStopped {
		t.Fatalf("gate after the stop: %v", err)
	}
	if len(stopped) != 1 || stopped[0] != "proc:a" {
		t.Fatalf("stop hooks: %v", stopped)
	}

	restarted := MakeManager(env)
	mustWatch(t, restarted, terminal("b1", "proc:z"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "c"))
	if err := restarted.Gate("proc:z"); err == nil {
		t.Fatal("a restart lifted the stop")
	}
	if _, l := linkOf(t, restarted.Snapshot("b1"), key); l.State != agentlinkwire.StateStopped {
		t.Fatalf("state after restart: %+v", l)
	}
	if err := restarted.Control(window, agentlinkwire.ControlRequest{BlockId: "b1", LinkKey: key, Action: agentlinkwire.ActionReconnect}); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Gate("proc:z"); err != nil {
		t.Fatalf("reconnect did not lift the stop: %v", err)
	}
	if len(env.Stops("b1")) != 0 {
		t.Fatalf("stops kept: %v", env.Stops("b1"))
	}
}

// A held watch returns the developer's Reconnect at once; a link MoltenTerm cannot reach refuses it.
func TestReconnectReachesTheHeldWatch(t *testing.T) {
	env := makeFakeEnv()
	m := MakeManager(env)
	key := LinkKey(agentlinkwire.ServerBrowser, 1001)
	got := make(chan agentlinkwire.WatchResult, 1)
	req := report("b1", agentlinkwire.ServerBrowser, 1001, 100, "c")
	req.HoldMs = int(time.Minute / time.Millisecond)
	go func() {
		res, _ := m.Watch(context.Background(), terminal("b1", "proc:a"), req)
		got <- res
	}()
	deadline := time.Now().Add(time.Minute)
	for len(m.Snapshot("b1").Agents) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the watch never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := m.Control(window, agentlinkwire.ControlRequest{BlockId: "b1", LinkKey: key, Action: agentlinkwire.ActionReconnect}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-got:
		if res.Action != agentlinkwire.ActionReconnect {
			t.Fatalf("watch result: %+v", res)
		}
	case <-time.After(time.Minute):
		t.Fatal("the watch did not return the action")
	}
	m.RouteDown("proc:a")
	if err := m.Control(window, agentlinkwire.ControlRequest{BlockId: "b1", LinkKey: key, Action: agentlinkwire.ActionReconnect}); err == nil {
		t.Fatal("reconnect of an unreachable link said nothing")
	}
}

func TestWatchIsBoundToItsTerminal(t *testing.T) {
	m := MakeManager(makeFakeEnv())
	if _, err := m.Watch(context.Background(), terminal("b2", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1, 1, "c")); err == nil {
		t.Fatal("a terminal reported for another")
	}
	if _, err := m.Watch(context.Background(), terminal("b1", "proc:a"), report("b1", "other", 1, 1, "c")); err == nil {
		t.Fatal("an unknown server was recorded")
	}
	if err := m.Bye(terminal("b1", "proc:a"), agentlinkwire.ByeRequest{Token: "tok-b1", Server: agentlinkwire.ServerBrowser, Pid: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.State(terminal("b1", "proc:a"), agentlinkwire.StateRequest{}); err == nil {
		t.Fatal("a terminal read the links")
	}
}

func TestByeAndLegacySessions(t *testing.T) {
	env := makeFakeEnv()
	env.runs["b1"] = molten.AgentRunInfo{BlockId: "b1", Agent: molten.AgentIdClaude, Running: true, Pid: 100}
	m := MakeManager(env)
	m.SetLegacySessions(func(blockId string) []LegacySession {
		return []LegacySession{{Source: "proc:a", ClientName: "Claude Code"}, {Source: "proc:old", ClientName: "Claude Code"}}
	})
	mustWatch(t, m, terminal("b1", "proc:a"), report("b1", agentlinkwire.ServerBrowser, 1001, 100, "claude-code"))
	state := m.Snapshot("b1")
	if len(state.Agents) != 1 || len(state.Agents[0].Links) != 2 {
		t.Fatalf("one reporting link, one legacy: %+v", state)
	}
	_, legacy := linkOf(t, state, "legacy:proc:old")
	if legacy.State != agentlinkwire.StateLegacy || legacy.Controllable {
		t.Fatalf("legacy: %+v", legacy)
	}
	if err := m.Bye(terminal("b1", "proc:a"), agentlinkwire.ByeRequest{Token: "tok-b1", Server: agentlinkwire.ServerBrowser, Pid: 1001}); err != nil {
		t.Fatal(err)
	}
	all, err := m.State(window, agentlinkwire.StateRequest{})
	if err != nil || len(all) != 1 || len(all[0].Agents[0].Links) != 2 {
		// proc:a's session is now reported as legacy: its server said goodbye but wavesrv still holds the session.
		t.Fatalf("after bye: %+v %v", all, err)
	}
}
