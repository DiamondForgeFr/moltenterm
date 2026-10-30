// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"fmt"
	"strconv"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Terminals from an earlier login (#1194). A logout ends the user's login session, but a durable shell is detached
// from the app and keeps running: it survives in a session the system no longer serves, so network names, user
// lookups, the process list and sound all fail for it and for everything it starts. Its job started before the
// current console login; a terminal started after it is fine.

var loginStartOnce sync.Once
var loginStartValue int64

// LoginStartMs is when the user's current login on this computer began, in Unix ms (0: unknown). wavesrv runs inside
// that login, so it is read once. Tests replace it.
var LoginStartMs = func() int64 {
	loginStartOnce.Do(func() {
		loginStartValue = readLoginStartMs()
	})
	return loginStartValue
}

// The Sessions view (frontend/moltenterm-shell/sessions), which lists them with their Update action.
const sessionsView = "molten-sessions"

func PreviousLoginCount(list []OutdatedTerminal) int {
	count := 0
	for _, t := range list {
		if t.Reason == ReasonPreviousLogin {
			count++
		}
	}
	return count
}

// PreviousLoginNotice tells that count terminals no longer reach the network, and where to restart them.
func PreviousLoginNotice(count int) molten.NotificationInput {
	open := molten.NotificationAction{Id: "open", Label: "Show sessions", Kind: "open", View: sessionsView,
		LabelText: uimsg.Make("notif.termupdate.showSessions")}
	message := fmt.Sprintf("%d terminal(s) were started before you last logged in to this computer: they and their agents can no longer reach the network. Restart them with Update terminal.", count)
	return molten.NotificationInput{Source: "sessions", Kind: "warning",
		Title:     "Some terminals lost network access",
		TitleText: uimsg.Make("notif.termupdate.previousLoginTitle"),
		Message:   message, MessageText: uimsg.Make("notif.termupdate.previousLogin", "count", strconv.Itoa(count)),
		Actions: []molten.NotificationAction{open}}
}

// StartedBeforeLogin:the job's command started before loginStartMs, so in a login session that has ended.
func StartedBeforeLogin(job *waveobj.Job, loginStartMs int64) bool {
	return job != nil && loginStartMs > 0 && job.CmdStartTs > 0 && job.CmdStartTs < loginStartMs
}
