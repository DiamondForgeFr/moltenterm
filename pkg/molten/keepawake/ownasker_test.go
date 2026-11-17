// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// #2257: Brokk's own session answers its permission requests in his layer. Only the terminal the caller's token names
// is asked for: a request naming another block is answered with nothing, and the asker is told the request is the
// terminal's own; its call may wait for the developer for as long as its hook allows, never more than the bound.
func TestOwnSessionAskerGetsOnlyTheCallersOwnRequests(t *testing.T) {
	var got []PermissionRequest
	var deadline time.Duration
	UseOwnSessionAsker(func(ctx context.Context, req PermissionRequest) (PermissionAnswer, bool) {
		got = append(got, req)
		if d, ok := ctx.Deadline(); ok {
			deadline = time.Until(d)
		}
		return PermissionAnswer{Decision: PermissionDeny, Message: "synthetic"}, true
	})
	t.Cleanup(func() { UseOwnSessionAsker(nil) })
	s := &service{keeper: makeFakeEnv().keeper(), locate: makeTtlCache[BlockInfo](), tabs: makeTtlCache[string]()}
	s.locate.put("brokk-1", BlockInfo{WorkspaceId: "ws-a"}, true, time.Now().Add(time.Hour))
	link := &routeLink{s: s}
	caller := localroute.Caller{IsLocalTerminal: true, BlockId: "brokk-1"}
	req := map[string]any{"blockid": "brokk-1", "toolname": "Bash", "toolinput": map[string]any{"command": "ls"}, "holdms": 120000}

	out, err := link.handle(context.Background(), PermissionCommand, caller, req)
	if err != nil || out.(PermissionAnswer).Decision != PermissionDeny {
		t.Fatalf("got %+v %v", out, err)
	}
	if len(got) != 1 || !got[0].FromBlock || got[0].BlockId != "brokk-1" {
		t.Fatalf("the asker got %+v", got)
	}
	if deadline < 100*time.Second || deadline > MaxPermissionHold {
		t.Fatalf("the call may wait %v", deadline)
	}

	other := map[string]any{"blockid": "brokk-1", "toolname": "Bash", "toolinput": map[string]any{"command": "ls"}}
	out, _ = link.handle(context.Background(), PermissionCommand, localroute.Caller{IsLocalTerminal: true, BlockId: "other"}, other)
	if out.(PermissionAnswer).Decision != "" || len(got) != 1 {
		t.Fatalf("a terminal spoke for Brokk's: %+v, asker called %d times", out, len(got))
	}
	// A forged FromBlock in the request is never read.
	forged := map[string]any{"blockid": "brokk-1", "toolname": "Bash", "FromBlock": true, "fromblock": true}
	link.handle(context.Background(), PermissionCommand, localroute.Caller{IsLocalTerminal: true}, forged)
	if len(got) != 2 || got[1].FromBlock {
		t.Fatalf("an unverified caller was taken for the terminal: %+v", got)
	}
	if permissionTimeout(PermissionRequest{HoldMs: int64(time.Hour / time.Millisecond)}) != MaxPermissionHold {
		t.Fatal("a hold past the bound")
	}
	if permissionTimeout(PermissionRequest{}) != storeTimeout {
		t.Fatal("a request with no hold answers at once")
	}
}
