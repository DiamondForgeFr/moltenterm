// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func TestRouteRefusesForwardedCallers(t *testing.T) {
	for _, source := range []string{"proc:remote", "tab:forged", "conn:remote"} {
		for _, command := range []string{molten.TaskReadCommand, molten.TaskHistoryCommand, molten.TaskRestoreCommand, molten.TaskClearCommand} {
			t.Run(source+"/"+command, func(t *testing.T) {
				s, _ := makeTestStore(t)
				if _, err := s.Update("ws-1", OwnerUser, setGoal("keep this goal", OwnerUser)); err != nil {
					t.Fatal(err)
				}
				path, _ := s.Path("ws-1")
				before, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				l := &routeLink{store: s, output: make(chan []byte, 1), localSource: func(gotSource string, gotLink baseds.LinkId) bool {
					if gotSource != source || gotLink != 7 {
						t.Errorf("source check got %q on %d", gotSource, gotLink)
					}
					return false
				}}
				req := wshutil.RpcMessage{Command: command, ReqId: "r1", Source: source, Data: map[string]any{"workspaceid": "ws-1", "create": true}}
				msg, err := json.Marshal(req)
				if err != nil {
					t.Fatal(err)
				}
				l.SendRpcMessage(msg, 7, "")
				select {
				case msg := <-l.output:
					var resp wshutil.RpcMessage
					if err := json.Unmarshal(msg, &resp); err != nil || resp.ResId != "r1" || !strings.Contains(resp.Error, "local terminals only") || resp.Data != nil {
						t.Fatalf("refused caller: %s (%v)", msg, err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("source check did not answer")
				}
				if after, err := os.ReadFile(path); err != nil || string(after) != string(before) {
					t.Fatalf("refused caller changed the checkpoint: %v", err)
				}
			})
		}
	}
}
