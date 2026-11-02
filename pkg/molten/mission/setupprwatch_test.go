// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The setup's draft is followed after the setup closes (#1788): one notification once its checks are done.

const setupPrUrl = "https://github.com/DiamondForgeFr/moltenterm/pull/1787"

func TestSetupPrVerdict(t *testing.T) {
	open := func(draft bool, checks string) SetupPrStatus {
		return SetupPrStatus{State: SetupPrStatusOpen, Draft: draft, Checks: checks}
	}
	cases := []struct {
		name    string
		status  SetupPrStatus
		round   int
		verdict string
	}{
		{"running", open(true, ReviewCheckPending), 5, setupPrVerdictWait},
		{"green", open(true, ReviewCheckSuccess), 1, setupPrVerdictReady},
		{"neutral", open(true, ReviewCheckNeutral), 1, setupPrVerdictReady},
		{"red", open(true, ReviewCheckFailure), 1, setupPrVerdictFailed},
		{"no checks yet", open(true, ReviewCheckNone), setupPrNoChecksRounds - 1, setupPrVerdictWait},
		{"no checks at all", open(true, ReviewCheckNone), setupPrNoChecksRounds, setupPrVerdictNoChecks},
		{"marked ready", open(false, ReviewCheckSuccess), 1, setupPrVerdictStop},
		{"merged", SetupPrStatus{State: SetupPrStatusMerged, Checks: ReviewCheckSuccess}, 1, setupPrVerdictStop},
		{"closed", SetupPrStatus{State: SetupPrStatusClosed, Draft: true}, 1, setupPrVerdictStop},
	}
	for _, c := range cases {
		if got := setupPrVerdict(c.status, c.round); got != c.verdict {
			t.Errorf("%s: %s, want %s", c.name, got, c.verdict)
		}
	}
}

func TestSetupPrNoticeSaysWhyAndOffersMarkReady(t *testing.T) {
	ready := setupPrNotice(setupPrVerdictReady, "/p", 1787, setupPrUrl, "develop")
	if ready.Key != SetupPrNoticePrefix+setupPrUrl || ready.Source != "release" || ready.Kind != "success" ||
		ready.TitleText.Code != "notif.setup.prReadyTitle" || ready.MessageText.Code != "notif.setup.prReady" ||
		!strings.Contains(ready.Message, "tests a change by hand") || ready.MessageText.Vars["target"] != "develop" {
		t.Fatalf("ready: %+v", ready)
	}
	if len(ready.Actions) != 2 || ready.Actions[0].Gesture != SetupPrReadyGesture || ready.Actions[0].Args["dir"] != "/p" ||
		ready.Actions[0].Args["url"] != setupPrUrl || ready.Actions[1].Gesture != SetupPrOpenGesture || !ready.Actions[1].Lasting {
		t.Fatalf("actions: %+v", ready.Actions)
	}
	if none := setupPrNotice(setupPrVerdictNoChecks, "/p", 1787, setupPrUrl, "develop"); none.MessageText.Code != "notif.setup.prReadyNoChecks" {
		t.Fatalf("no checks: %+v", none)
	}
	failed := setupPrNotice(setupPrVerdictFailed, "/p", 1787, setupPrUrl, "develop")
	if failed.Kind != "warning" || failed.TitleText.Code != "notif.setup.prFailedTitle" || len(failed.Actions) != 1 ||
		failed.Actions[0].Gesture != SetupPrOpenGesture {
		t.Fatalf("failed: %+v", failed)
	}
}

// ghSetupPrAnswers: gh pr view answers, one per look; the last one repeats.
func ghSetupPrAnswers(answers ...string) (func(ctx context.Context, dir string, name string, args ...string) ([]byte, error), func() int) {
	var lock sync.Mutex
	looks := 0
	run := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		lock.Lock()
		defer lock.Unlock()
		if name != "gh" || strings.Join(args[:3], " ") != "pr view 1787" {
			return nil, errors.New("unexpected " + name + " " + strings.Join(args, " "))
		}
		answer := answers[min(looks, len(answers)-1)]
		looks++
		if answer == "" {
			return nil, errors.New("gh: could not connect")
		}
		return []byte(answer), nil
	}
	return run, func() int {
		lock.Lock()
		defer lock.Unlock()
		return looks
	}
}

func setupPrJson(draft bool, check string) string {
	rollup := ""
	if check != "" {
		rollup = `{"__typename":"CheckRun","name":"quick","status":"COMPLETED","conclusion":"` + check + `"}`
		if check == "PENDING" {
			rollup = `{"__typename":"CheckRun","name":"quick","status":"IN_PROGRESS","conclusion":""}`
		}
	}
	isDraft := "false"
	if draft {
		isDraft = "true"
	}
	return `{"number":1787,"url":"` + setupPrUrl + `","state":"OPEN","isDraft":` + isDraft +
		`,"headRefName":"feature/1786-release-pipeline","baseRefName":"develop","statusCheckRollup":[` + rollup + `]}`
}

func TestSetupPrWatchTellsOnceTheChecksAreGreen(t *testing.T) {
	run, looks := ghSetupPrAnswers(setupPrJson(true, "PENDING"), "", setupPrJson(true, "SUCCESS"))
	published := make(chan molten.NotificationInput, 4)
	w := &SetupPrWatch{Run: run, Every: time.Millisecond, Rounds: 1000,
		Publish: func(ctx context.Context, input molten.NotificationInput) error {
			published <- input
			return nil
		}}
	w.Watch("/p", 1787, setupPrUrl, "develop")
	// A second call for the same pull request while it is followed starts nothing.
	w.Watch("/p", 1787, setupPrUrl, "develop")
	select {
	case got := <-published:
		if got.TitleText.Code != "notif.setup.prReadyTitle" || got.Actions[0].Gesture != SetupPrReadyGesture {
			t.Fatalf("published: %+v", got)
		}
	case <-time.After(time.Minute):
		t.Fatal("nothing was published")
	}
	waitSetupPrWatchIdle(t, w)
	if n := looks(); n != 3 {
		t.Fatalf("looks: %d (one watch, stopped at green)", n)
	}
	if len(published) != 0 {
		t.Fatal("published twice")
	}
}

func TestSetupPrWatchStaysQuietWhenTheDraftIsMarkedReady(t *testing.T) {
	run, looks := ghSetupPrAnswers(setupPrJson(true, "PENDING"), setupPrJson(false, "PENDING"))
	var published []molten.NotificationInput
	var lock sync.Mutex
	w := &SetupPrWatch{Run: run, Every: time.Millisecond, Rounds: 1000,
		Publish: func(ctx context.Context, input molten.NotificationInput) error {
			lock.Lock()
			defer lock.Unlock()
			published = append(published, input)
			return nil
		}}
	w.Watch("/p", 1787, setupPrUrl, "develop")
	waitSetupPrWatchIdle(t, w)
	lock.Lock()
	defer lock.Unlock()
	if len(published) != 0 || looks() != 2 {
		t.Fatalf("published %+v after %d looks", published, looks())
	}
}

func waitSetupPrWatchIdle(t *testing.T, w *SetupPrWatch) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		w.lock.Lock()
		idle := len(w.watching) == 0
		w.lock.Unlock()
		if idle {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("the watch did not end")
}
