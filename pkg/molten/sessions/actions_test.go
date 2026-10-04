// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type fakeOps struct {
	calls       []string
	attachErr   error
	tabWs       map[string]string
	activeTab   map[string]string
	terminateEr error
	// onCreate runs when a pane is made (the list changing meanwhile).
	onCreate func()
}

func (f *fakeOps) rec(format string, args ...any) {
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
}

func (f *fakeOps) TerminateJob(ctx context.Context, jobId string) error {
	f.rec("terminate %s", jobId)
	return f.terminateEr
}

func (f *fakeOps) TerminateAndDetachJob(ctx context.Context, jobId string) error {
	f.rec("terminate+detach %s", jobId)
	return f.terminateEr
}

func (f *fakeOps) DetachJob(ctx context.Context, jobId string) error {
	f.rec("detach %s", jobId)
	return nil
}

func (f *fakeOps) CreatePane(ctx context.Context, tabId string, s molten.DurableSession) (string, error) {
	f.rec("create %s cwd=%s conn=%s", tabId, s.Folder, s.Connection)
	if f.onCreate != nil {
		f.onCreate()
	}
	return "newblock", nil
}

func (f *fakeOps) CopyHistory(ctx context.Context, jobId string, blockId string) error {
	f.rec("copy %s %s", jobId, blockId)
	return nil
}

func (f *fakeOps) AttachJob(ctx context.Context, jobId string, blockId string) error {
	f.rec("attach %s %s", jobId, blockId)
	return f.attachErr
}

func (f *fakeOps) DeletePane(ctx context.Context, blockId string) error {
	f.rec("delete %s", blockId)
	return nil
}

func (f *fakeOps) InsertPane(ctx context.Context, tabId string, blockId string) error {
	f.rec("insert %s %s", tabId, blockId)
	return nil
}

func (f *fakeOps) WorkspaceOfTab(ctx context.Context, tabId string) (string, error) {
	ws, ok := f.tabWs[tabId]
	if !ok {
		return "", errors.New("no such tab")
	}
	return ws, nil
}

func (f *fakeOps) ActiveTab(ctx context.Context, workspaceId string) (string, error) {
	return f.activeTab[workspaceId], nil
}

func (f *fakeOps) SetActiveTab(ctx context.Context, workspaceId string, tabId string) error {
	f.rec("activate %s %s", workspaceId, tabId)
	return nil
}

func (f *fakeOps) FocusBlock(ctx context.Context, tabId string, blockId string) error {
	f.rec("focus %s %s", tabId, blockId)
	return nil
}

func (f *fakeOps) ConnectHost(ctx context.Context, connection string) error {
	f.rec("connect %s", connection)
	return nil
}

func (f *fakeOps) ReconnectJob(ctx context.Context, jobId string) error {
	f.rec("reconnect %s", jobId)
	return nil
}

func (f *fakeOps) trace() string {
	return strings.Join(f.calls, "; ")
}

func makeTestActions(sessions ...molten.DurableSession) (*Actions, *fakeBuild, *fakeOps) {
	f := &fakeBuild{}
	f.set(sessions...)
	ops := &fakeOps{tabWs: map[string]string{"tabA": "wsA", "tabB": "wsB", "tabB2": "wsB"}, activeTab: map[string]string{"wsB": "tabB2"}}
	return MakeActions(MakeModel(f.build, f.publish), ops), f, ops
}

var shownB = molten.DurableSession{Id: "shown", Shown: true, CanShow: true, CanEnd: true, WorkspaceId: "wsB", TabId: "tabB", BlockId: "blockB"}
var detachedS = molten.DurableSession{Id: "detached", Reason: molten.SessionReasonDetached, CanShow: true, CanEnd: true, Folder: "/home/me/app"}
var paneGoneS = molten.DurableSession{Id: "panegone", Reason: molten.SessionReasonPaneGone, CanShow: true, CanEnd: true, Connection: "me@box"}
var olderS = molten.DurableSession{Id: "older", Shown: true, Reason: molten.SessionReasonOlderVersion, CanEnd: true, WorkspaceId: "wsA", TabId: "tabA", BlockId: "blockOld"}

func TestEnd(t *testing.T) {
	a, _, ops := makeTestActions(shownB, detachedS)
	ctx := context.Background()
	if _, err := a.End(ctx, "shown", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.End(ctx, "detached", ""); err != nil {
		t.Fatal(err)
	}
	if got := ops.trace(); got != "terminate shown; terminate+detach detached" {
		t.Fatalf("a pane keeps its ended terminal, a session no pane shows is detached: %s", got)
	}
	if _, err := a.End(ctx, "shown", "blockB"); err == nil || !strings.Contains(err.Error(), "cannot end itself") {
		t.Fatalf("own session: %v", err)
	}
	if _, err := a.End(ctx, "gone", ""); err == nil || !strings.Contains(err.Error(), "no longer running") {
		t.Fatalf("gone session: %v", err)
	}
	if _, err := a.End(ctx, "", ""); err == nil {
		t.Fatalf("no id")
	}
}

func TestEndUnreachableHostIsPending(t *testing.T) {
	down := paneGoneS
	down.ConnState = molten.SessionConnDisconnected
	up := detachedS
	up.Id, up.Connection, up.ConnState = "hostup", "me@box", molten.SessionConnConnected
	a, _, ops := makeTestActions(down, up)
	ops.terminateEr = errors.New("connection down")
	res, err := a.End(context.Background(), "panegone", "")
	if err != nil || !res.Pending {
		t.Fatalf("an unreachable host ends the session later: %+v %v", res, err)
	}
	if _, err := a.End(context.Background(), "hostup", ""); err == nil {
		t.Fatalf("a failure with the host up is an error, not a pending end")
	}
}

func TestReattachFailureRemovesThePane(t *testing.T) {
	a, _, ops := makeTestActions(detachedS)
	ops.attachErr = errors.New("already attached")
	if _, err := a.Show(context.Background(), "detached", "tabA"); err == nil {
		t.Fatalf("attach failure not reported")
	}
	if got := ops.trace(); !strings.HasSuffix(got, "attach detached newblock; delete newblock") {
		t.Fatalf("the pane of a failed reattach is removed: %s", got)
	}
}

func TestCleanupSkipsSessionsShownSince(t *testing.T) {
	a, f, ops := makeTestActions(detachedS, paneGoneS)
	// Between the list on screen and the confirmation, panegone was shown in a pane again.
	reattached := paneGoneS
	reattached.Shown, reattached.Reason = true, ""
	f.set(detachedS, reattached)
	res, err := a.Cleanup(context.Background(), []string{"detached", "panegone", "vanished"})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(res.Ended) != "[detached]" || fmt.Sprint(res.Skipped) != "[panegone vanished]" {
		t.Fatalf("cleanup: %+v", res)
	}
	if got := ops.trace(); got != "terminate+detach detached" {
		t.Fatalf("only the session no pane shows is ended: %s", got)
	}
}

func TestShowShownInOtherWorkspace(t *testing.T) {
	a, _, ops := makeTestActions(shownB)
	loc, err := a.Show(context.Background(), "shown", "tabA")
	if err != nil {
		t.Fatal(err)
	}
	if loc != (molten.SessionLocation{WorkspaceId: "wsB", TabId: "tabB", BlockId: "blockB"}) {
		t.Fatalf("location: %+v", loc)
	}
	if got := ops.trace(); got != "activate wsB tabB; focus tabB blockB" {
		t.Fatalf("another workspace gets its tab set before the switch: %s", got)
	}
}

func TestShowShownInOwnWorkspace(t *testing.T) {
	a, _, ops := makeTestActions(shownB)
	if _, err := a.Show(context.Background(), "shown", "tabB2"); err != nil {
		t.Fatal(err)
	}
	if got := ops.trace(); got != "focus tabB blockB" {
		t.Fatalf("the window switches tab itself: %s", got)
	}
}

func TestShowReattachOrder(t *testing.T) {
	a, _, ops := makeTestActions(detachedS, paneGoneS)
	loc, err := a.Show(context.Background(), "detached", "tabA")
	if err != nil {
		t.Fatal(err)
	}
	if loc != (molten.SessionLocation{WorkspaceId: "wsA", TabId: "tabA", BlockId: "newblock", Created: true}) {
		t.Fatalf("location: %+v", loc)
	}
	if got := ops.trace(); got != "create tabA cwd=/home/me/app conn=; copy detached newblock; attach detached newblock; insert tabA newblock" {
		t.Fatalf("reattach: %s", got)
	}
	ops.calls = nil
	if _, err := a.Show(context.Background(), "panegone", "tabA"); err != nil {
		t.Fatal(err)
	}
	if got := ops.trace(); got != "detach panegone; create tabA cwd= conn=me@box; copy panegone newblock; attach panegone newblock; insert tabA newblock" {
		t.Fatalf("a stale link is dropped first: %s", got)
	}
}

func TestShowRefused(t *testing.T) {
	ending := molten.DurableSession{Id: "ending", Reason: molten.SessionReasonEnding}
	a, _, ops := makeTestActions(olderS, ending, detachedS)
	if _, err := a.Show(context.Background(), "older", "tabA"); err == nil || !strings.Contains(err.Error(), "older MoltenTerm") {
		t.Fatalf("older version: %v", err)
	}
	if _, err := a.Show(context.Background(), "ending", "tabA"); err == nil {
		t.Fatalf("ending: shown")
	}
	if _, err := a.Show(context.Background(), "detached", ""); err == nil {
		t.Fatalf("no tab to reattach into")
	}
	if len(ops.calls) != 0 {
		t.Fatalf("refused shows change nothing: %s", ops.trace())
	}
}

func TestReconnect(t *testing.T) {
	a, _, ops := makeTestActions(paneGoneS, detachedS)
	if err := a.Reconnect(context.Background(), "panegone"); err != nil {
		t.Fatal(err)
	}
	if err := a.Reconnect(context.Background(), "detached"); err != nil {
		t.Fatal(err)
	}
	if got := ops.trace(); got != "connect me@box; reconnect panegone; reconnect detached" {
		t.Fatalf("the host first, then the job: %s", got)
	}
}

func TestStartupReconnects(t *testing.T) {
	data := molten.DurableSessionsData{Sessions: []molten.DurableSession{
		{Id: "local-down", Shown: true, CanShow: true, ConnState: molten.SessionConnDisconnected},
		{Id: "local-up", Shown: true, CanShow: true, ConnState: molten.SessionConnConnected},
		{Id: "ssh-hostup", Shown: true, CanShow: true, Connection: "up", ConnState: molten.SessionConnDisconnected},
		{Id: "ssh-hostdown", Shown: true, CanShow: true, Connection: "down", ConnState: molten.SessionConnDisconnected},
		{Id: "hidden", CanShow: true, ConnState: molten.SessionConnDisconnected},
		{Id: "older", Shown: true, ConnState: molten.SessionConnDisconnected},
		{Id: "on-screen", Shown: true, CanShow: true, WorkspaceId: "ws1", TabId: "active", ConnState: molten.SessionConnDisconnected},
		{Id: "ending-local", Reason: molten.SessionReasonEnding, ConnState: molten.SessionConnDisconnected},
		{Id: "ending-down", Reason: molten.SessionReasonEnding, Connection: "down", ConnState: molten.SessionConnDisconnected},
	}}
	got := StartupReconnects(data, func(c string) bool { return c == "up" }, func(ws string) string {
		if ws == "ws1" {
			return "active"
		}
		return ""
	})
	if fmt.Sprint(got) != "[local-down ssh-hostup ending-local]" {
		t.Fatalf("startup reconnects: %v", got)
	}
}
