// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package buildchannel is wavesrv's side of the build channel (FR-REL-001): Electron main gives wavesrv the channel
// baked into the app and whether it runs unpackaged (emain/moltenterm-build-channel.ts), and wavesrv decides the gate of
// what only some channels have with the same rule as the window (frontend/moltenterm-shell/build/build-channel.ts
// gateChannel), so that a hidden window is never the only lock (FR-BOSS-010 AC1, #2246).
package buildchannel

import "os"

// The variables Electron main sets for wavesrv; must match emain/moltenterm-build-channel.ts. wavesrv reads them once
// and removes them, so a terminal never hands them on (a build started there reads MOLTENTERM_BUILD_CHANNEL, never
// these).
const (
	AppChannelEnv = "MOLTENTERM_APP_CHANNEL"
	AppDevEnv     = "MOLTENTERM_APP_DEV"
	// RuntimeChannelEnv is the launcher's mark on a gold copy; it may only narrow the gate.
	RuntimeChannelEnv = "MOLTENTERM_CHANNEL"
)

// The channels; must match BuildChannelNames in frontend/moltenterm-shell/build/build-channel.ts.
const (
	Dev    = "dev"
	Local  = "local"
	Gold   = "gold"
	RC     = "rc"
	Public = "public"
	// Unknown is what a name this build does not know resolves to: it opens nothing.
	Unknown = "unknown"
)

// BrainstormRefusal is the plain reason the brainstorm commands give on a release channel.
const BrainstormRefusal = "brainstorms with Brokk exist only on gold, dev and local builds"

// gateReach is how much of what is gated a channel opens: the brainstorm on gold, its scripted replay too on local and
// dev.
var gateReach = map[string]int{RC: 0, Public: 0, Gold: 1, Local: 2, Dev: 2}

func known(channel string) bool {
	_, ok := gateReach[channel]
	return ok
}

// GateChannel is the channel the gated features follow. An unpackaged app is dev. Otherwise the channel baked into
// the app decides: a release candidate or a public release stays one whatever the launcher says, a launcher's channel
// is followed only when it opens no more than the baked one (a gold copy marked rc, never a gold marked dev), and a
// name that is not a channel resolves to Unknown. An app that names no baked channel is a local build, as
// build-info.ts bakes it.
func GateChannel(dev bool, baked string, runtime string) string {
	if dev {
		return Dev
	}
	if baked == "" {
		baked = Local
	}
	if !known(baked) {
		return Unknown
	}
	if runtime == "" || baked == RC || baked == Public {
		return baked
	}
	if !known(runtime) {
		return Unknown
	}
	if gateReach[runtime] > gateReach[baked] {
		return baked
	}
	return runtime
}

// BrainstormAllowed: Brokk's thought in 3D exists on gold, dev and local builds, never on a release candidate or a
// public release, and never on a channel that is not known.
func BrainstormAllowed(channel string) bool {
	return channel == Gold || channel == Dev || channel == Local
}

// What Electron main said when wavesrv started; "" when it was started without it (tests, a hand-started wavesrv),
// which leaves the gate shut.
var started struct {
	given   bool
	channel string
}

func init() {
	started.given, started.channel = takeFromEnv()
}

// takeFromEnv reads what Electron main gave and removes it from the environment.
func takeFromEnv() (bool, string) {
	baked, given := os.LookupEnv(AppChannelEnv)
	dev := os.Getenv(AppDevEnv) == "1"
	os.Unsetenv(AppChannelEnv)
	os.Unsetenv(AppDevEnv)
	if !given {
		return false, ""
	}
	return true, GateChannel(dev, baked, os.Getenv(RuntimeChannelEnv))
}

// Current is the gate channel of this wavesrv; "" when Electron main gave none.
func Current() string {
	return started.channel
}

// BrainstormEnabled reads the gate for the channel this wavesrv runs on.
func BrainstormEnabled() bool {
	return started.given && BrainstormAllowed(started.channel)
}
