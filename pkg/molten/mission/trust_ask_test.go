// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

type trustAskRecorder struct {
	lock     sync.Mutex
	notices  []molten.NotificationInput
	resolved []string
	told     map[string]string
}

func (rec *trustAskRecorder) asks() *TrustAsks {
	a := MakeTrustAsks()
	a.notify = func(_ context.Context, input molten.NotificationInput) error {
		rec.lock.Lock()
		defer rec.lock.Unlock()
		rec.notices = append(rec.notices, input)
		return nil
	}
	a.resolve = func(_ context.Context, key string) error {
		rec.lock.Lock()
		defer rec.lock.Unlock()
		rec.resolved = append(rec.resolved, key)
		return nil
	}
	a.tell = func(_ context.Context, blockId string, line string) bool {
		rec.lock.Lock()
		defer rec.lock.Unlock()
		if rec.told == nil {
			rec.told = map[string]string{}
		}
		rec.told[blockId] = line
		return true
	}
	return a
}

func (rec *trustAskRecorder) noticeCount() int {
	rec.lock.Lock()
	defer rec.lock.Unlock()
	return len(rec.notices)
}

func askRun(t *testing.T, link *localroute.Link, from routetest.From, dir string) RunResult {
	t.Helper()
	data, errText := routetest.Ask(t, link, from, RunCommand, map[string]any{"dir": dir, "kind": RunKindBuild, "id": "gold"})
	if errText != "" {
		t.Fatalf("run from %s: %s", from.Name, errText)
	}
	var res RunResult
	if err := utilfn.ReUnmarshal(&res, data); err != nil {
		t.Fatal(err)
	}
	return res
}

// #1017: a run refused from a terminal asks the developer by one notification per folder and runs nothing; a window
// shows its own sheet and is not notified. The developer's Trust closes the question and tells the refused agent; a
// changed command asks again.
func TestTrustAskFromTerminal(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo hi"}`)
	rec := &trustAskRecorder{}
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{runs: r, asks: rec.asks()}).route())
	if err != nil {
		t.Fatal(err)
	}

	if res := askRun(t, link, e.Window(), dir); res.Untrusted == nil || res.Run != nil {
		t.Fatalf("a window's first run must ask for trust: %+v", res)
	}
	if rec.noticeCount() != 0 {
		t.Fatalf("a window's refusal must not notify: %+v", rec.notices)
	}

	res := askRun(t, link, e.Terminal(), dir)
	if res.Untrusted == nil || res.Run != nil {
		t.Fatalf("a terminal's run must be refused: %+v", res)
	}
	askRun(t, link, e.Terminal(), dir)
	if rec.noticeCount() != 2 {
		t.Fatalf("each refusal publishes the folder's notification: %d", rec.noticeCount())
	}
	notice := rec.notices[1]
	if notice.Key != TrustNotificationKey(dir) || rec.notices[0].Key != notice.Key || notice.Source != TrustNotificationSource {
		t.Fatalf("one notification per folder: %+v", rec.notices)
	}
	if len(notice.Actions) != 1 || notice.Actions[0].Gesture != TrustReviewGesture || notice.Actions[0].Args["dir"] != dir {
		t.Fatalf("the action opens the sheet for the folder: %+v", notice.Actions)
	}
	blocks, _ := notice.Actions[0].Args["blockids"].([]string)
	if len(blocks) != 1 || blocks[0] != routetest.TerminalBlock {
		t.Fatalf("the refused terminal is named once: %+v", notice.Actions[0].Args)
	}
	if len(r.List(dir)) != 0 {
		t.Fatal("nothing runs before the developer's click")
	}

	info, err := r.Untrusted(dir)
	if err != nil || info == nil || info.Hash != res.Untrusted.Hash {
		t.Fatalf("the sheet reads what the run was refused for: %+v, %v", info, err)
	}
	if _, errText := routetest.Ask(t, link, e.Terminal(), TrustCommand, map[string]any{"dir": dir, "hash": info.Hash}); errText == "" {
		t.Fatal("a terminal must never trust")
	}
	if _, errText := routetest.Ask(t, link, e.Window(), TrustCommand, map[string]any{"dir": dir, "hash": info.Hash}); errText != "" {
		t.Fatalf("the window's trust: %s", errText)
	}
	if len(rec.resolved) != 1 || rec.resolved[0] != TrustNotificationKey(dir) {
		t.Fatalf("the trust closes the question: %+v", rec.resolved)
	}
	if line := rec.told[routetest.TerminalBlock]; !strings.HasPrefix(line, trustReceiptPrefix) || !strings.Contains(line, dir) {
		t.Fatalf("the refused agent is told to run again: %q", line)
	}
	if again, _ := r.Untrusted(dir); again != nil {
		t.Fatalf("trusted commands ask nothing: %+v", again)
	}

	started := askRun(t, link, e.Terminal(), dir)
	if started.Untrusted != nil || started.Run == nil {
		t.Fatalf("the rerun passes the trust check: %+v", started)
	}
	waitRun(t, r, dir, started.Run.Id)
	if rec.noticeCount() != 2 {
		t.Fatal("a trusted run asks nothing")
	}

	writePipeline(t, dir, `{"id":"gold","title":"Gold","run":"echo changed"}`)
	if res := askRun(t, link, e.Terminal(), dir); res.Untrusted == nil || res.Run != nil || rec.noticeCount() != 3 {
		t.Fatalf("a changed command asks again: %+v", res)
	}
}

// A worktree's folder never borrows the project folder's trust, even with the same commands.
func TestTrustIsPerFolder(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"echo hi"}`)
	info, err := r.Untrusted(dir)
	if err != nil || info == nil {
		t.Fatalf("untrusted at first: %+v, %v", info, err)
	}
	if err := r.GrantTrust(dir, info.Hash); err != nil {
		t.Fatal(err)
	}
	copyDir := t.TempDir()
	writePipeline(t, copyDir, `{"id":"gold","run":"echo hi"}`)
	if got, _ := r.Untrusted(copyDir); got == nil || got.Hash != info.Hash {
		t.Fatalf("another folder with the same commands still asks: %+v", got)
	}
}

func TestTrustReceipt(t *testing.T) {
	if got := trustReceipt("/p/App", "molten ci run"); got != "[MoltenTerm] The developer trusted the commands of App (/p/App): run `molten ci run` again." {
		t.Errorf("receipt: %q", got)
	}
	if got := trustReceipt("/p/App", ""); !strings.HasSuffix(got, "run the refused command again.") {
		t.Errorf("receipt without a command: %q", got)
	}
}
