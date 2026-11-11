// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package buildchannel is wavesrv's side of the build channel (FR-REL-001): Electron main names the channel the app
// runs on (emain/moltenterm-build-channel.ts) and gives it to wavesrv at launch. What exists only on some channels asks
// here, so that a hidden window is never the only lock (FR-BOSS-010 AC1, #2246).
package buildchannel

import "os"

// Env must match BuildChannelEnv in emain/moltenterm-build-channel.ts.
const Env = "MOLTENTERM_BUILD_CHANNEL"

// The channels; must match BuildChannel in frontend/moltenterm-shell/build/build-identity.ts.
const (
	Dev    = "dev"
	Local  = "local"
	Gold   = "gold"
	RC     = "rc"
	Public = "public"
)

// BrainstormRefusal is the plain reason the brainstorm commands give on a release channel.
const BrainstormRefusal = "brainstorms with Brokk exist only on gold, dev and local builds"

// Current is the channel Electron main gave; "" when wavesrv was started without one.
func Current() string {
	return os.Getenv(Env)
}

// BrainstormAllowed: Brokk's thought in 3D exists on gold, dev and local builds, never on a release candidate or a
// public release. A missing or unknown channel is refused, so a wavesrv started without one shows nothing.
func BrainstormAllowed(channel string) bool {
	return channel == Gold || channel == Dev || channel == Local
}

// BrainstormEnabled reads the gate for the channel this wavesrv runs on.
func BrainstormEnabled() bool {
	return BrainstormAllowed(Current())
}
