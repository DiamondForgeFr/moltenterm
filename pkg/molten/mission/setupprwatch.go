// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// A draft the release setup opened waits for the developer (#1788): their workflow tests a change by hand before its
// review, and only they take it out of draft. wavesrv follows it after the setup closes and says, by notification, when
// its checks are done: green (or none came) with Mark ready and Open, red with Open. Nothing is marked ready unasked;
// a draft someone marked ready, merged or closed ends the watch without a word.

const (
	// must match frontend/moltenterm-shell/mission/release-setup-gestures.ts
	SetupPrReadyGesture = "setup:prready"
	SetupPrOpenGesture  = "setup:propen"

	SetupPrNoticePrefix = "pipelinesetup:draftpr:"

	setupPrWatchEvery = 30 * time.Second
	// Three hours of checks at most; a project's CI that takes longer is followed in step 3 and in Integration.
	setupPrWatchRounds = 360
	// Ten minutes without any check: the project runs none on its pull requests.
	setupPrNoChecksRounds = 20

	setupPrVerdictWait     = "wait"
	setupPrVerdictStop     = "stop"
	setupPrVerdictReady    = "ready"
	setupPrVerdictNoChecks = "nochecks"
	setupPrVerdictFailed   = "failed"
)

type SetupPrWatch struct {
	Run     pipelinesetup.Runner
	Every   time.Duration
	Rounds  int
	Publish func(ctx context.Context, input molten.NotificationInput) error

	lock     sync.Mutex
	watching map[string]bool
}

func MakeSetupPrWatch(run pipelinesetup.Runner) *SetupPrWatch {
	return &SetupPrWatch{Run: run, Every: setupPrWatchEvery, Rounds: setupPrWatchRounds, Publish: attention.PublishNotification}
}

// setupPrVerdict reads one look at the draft; round counts the looks, from 1.
func setupPrVerdict(status SetupPrStatus, round int) string {
	if status.State != SetupPrStatusOpen || !status.Draft {
		return setupPrVerdictStop
	}
	switch status.Checks {
	case ReviewCheckSuccess, ReviewCheckNeutral:
		return setupPrVerdictReady
	case ReviewCheckFailure:
		return setupPrVerdictFailed
	case ReviewCheckNone:
		if round >= setupPrNoChecksRounds {
			return setupPrVerdictNoChecks
		}
	}
	return setupPrVerdictWait
}

func setupPrNotice(verdict string, dir string, number int, url string, target string) molten.NotificationInput {
	n := strconv.Itoa(number)
	open := molten.NotificationAction{Id: "open", Label: "Open", Kind: "gesture", Gesture: SetupPrOpenGesture,
		Args: map[string]any{"url": url}, Lasting: true, LabelText: uimsg.Make("notif.setup.open")}
	input := molten.NotificationInput{Key: SetupPrNoticePrefix + url, Source: "release", Kind: "success"}
	if verdict == setupPrVerdictFailed {
		input.Kind = "warning"
		input.Title = fmt.Sprintf("The release setup's pull request #%s has failed checks", n)
		input.TitleText = uimsg.Make("notif.setup.prFailedTitle", "number", n)
		input.Message = fmt.Sprintf("#%s is still a draft: open it to see why. Nothing is merged into %s.", n, target)
		input.MessageText = uimsg.Make("notif.setup.prFailed", "number", n, "target", target)
		input.Actions = []molten.NotificationAction{open}
		return input
	}
	ready := molten.NotificationAction{Id: "ready", Label: "Mark ready", Kind: "gesture", Gesture: SetupPrReadyGesture,
		Args: map[string]any{"dir": dir, "url": url}, LabelText: uimsg.Make("notif.setup.markReady")}
	input.Title = "The release setup's pull request is ready for your review"
	input.TitleText = uimsg.Make("notif.setup.prReadyTitle", "number", n)
	input.Message = fmt.Sprintf("#%s's checks are green. It is a draft because your project's workflow tests a change by hand "+
		"before its review: mark it ready once you have, then merge it into %s.", n, target)
	input.MessageText = uimsg.Make("notif.setup.prReady", "number", n, "target", target)
	if verdict == setupPrVerdictNoChecks {
		input.Message = fmt.Sprintf("#%s runs no checks. It is a draft because your project's workflow tests a change by hand "+
			"before its review: mark it ready once you have, then merge it into %s.", n, target)
		input.MessageText = uimsg.Make("notif.setup.prReadyNoChecks", "number", n, "target", target)
	}
	input.Actions = []molten.NotificationAction{ready, open}
	return input
}

// Watch follows one draft until its checks are done; a second call for the same pull request is ignored.
func (w *SetupPrWatch) Watch(dir string, number int, url string, target string) {
	if !w.start(url) {
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:mission:setupprwatch", recover())
		}()
		defer w.stop(url)
		w.follow(dir, number, url, target)
	}()
}

func (w *SetupPrWatch) start(url string) bool {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.watching == nil {
		w.watching = map[string]bool{}
	}
	if w.watching[url] {
		return false
	}
	w.watching[url] = true
	return true
}

func (w *SetupPrWatch) stop(url string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	delete(w.watching, url)
}

func (w *SetupPrWatch) follow(dir string, number int, url string, target string) {
	for round := 1; round <= w.Rounds; round++ {
		time.Sleep(w.Every)
		if w.followRound(dir, number, url, target, round) {
			return
		}
	}
}

// followRound reads the pull request once; true when the watch ends. A panic ends that round only.
func (w *SetupPrWatch) followRound(dir string, number int, url string, target string, round int) (ended bool) {
	defer func() {
		panichandler.PanicHandler("molten:mission:setupprwatch:round", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	status, err := ReadSetupPrStatus(ctx, w.Run, SetupPrStatusRequest{Dir: dir, Number: number})
	cancel()
	if err != nil {
		return false
	}
	verdict := setupPrVerdict(status, round)
	if verdict == setupPrVerdictWait {
		return false
	}
	if verdict == setupPrVerdictStop {
		return true
	}
	if status.Base != "" {
		target = status.Base
	}
	ctx, cancel = context.WithTimeout(context.Background(), keptNoticeTimeout)
	defer cancel()
	if err := w.Publish(ctx, setupPrNotice(verdict, dir, number, url, target)); err != nil {
		log.Printf("molten: telling the release setup's pull request #%d waits: %v\n", number, err)
	}
	return true
}
