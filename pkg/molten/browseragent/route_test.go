// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func sendToLink(t *testing.T, l *routeLink, msg wshutil.RpcMessage) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	l.SendRpcMessage(data, 0, "test")
}

// emain reports takeover without asking for an answer: the command runs all the same, and nothing is sent back.
func TestRouteRunsCommandsWithoutReqId(t *testing.T) {
	m, env, _ := makeWorld(t)
	l := &routeLink{manager: m, output: make(chan []byte, 4), pending: make(map[string]context.CancelFunc)}
	sid := hello(t, m, "proc:a", "tok-a", "a")
	createdTabId(t, call(m, "proc:a", sid, mcpbrowser.ToolTabsCreate, `{}`))
	state, _ := env.lastPublished("p1")
	sendToLink(t, l, wshutil.RpcMessage{
		Command: mcpbrowser.ControlCommand,
		Source:  wshutil.ElectronRoute,
		Data:    ControlRequest{BlockId: "p1", BrowserTabId: state.Tabs[0].BrowserTabId, Action: ControlTakeOver},
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		snapshot, _ := m.PanelSnapshot("tab:t1", "p1")
		if len(snapshot.Tabs) == 1 && snapshot.Tabs[0].State == TabStateTakenOver {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the no-answer takeover never applied: %+v", snapshot)
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case out := <-l.output:
		t.Fatalf("a command without reqid gets no answer, got %s", out)
	case <-time.After(50 * time.Millisecond):
	}
	sendToLink(t, l, wshutil.RpcMessage{Command: mcpbrowser.StateCommand, ReqId: "r1", Source: "proc:a", Data: StateRequest{BlockId: "p1"}})
	select {
	case out := <-l.output:
		var resp wshutil.RpcMessage
		json.Unmarshal(out, &resp)
		if resp.ResId != "r1" || resp.Error == "" {
			t.Fatalf("a terminal reading panel state is refused: %s", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no answer")
	}
}
