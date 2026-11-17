// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Electron main tells wavesrv at launch about the build (FR-REL-001, FR-BOSS-010 AC1, #2246): wavesrv has no build
// facts of its own, and what exists only on some channels must be refused there too, not only hidden in the window. It
// gets the channel baked into the app and whether the app runs unpackaged, and decides the gate itself with the
// window's rule (pkg/molten/buildchannel GateChannel, frontend/moltenterm-shell/build/build-channel.ts gateChannel):
// the launcher's MOLTENTERM_CHANNEL, which wavesrv inherits, may only narrow it. wavesrv reads both variables once and
// removes them, so its terminals never hand them on.

declare const __MOLTENTERM_CHANNEL__: string;

// must match pkg/molten/buildchannel/buildchannel.go
export const AppChannelEnv = "MOLTENTERM_APP_CHANNEL";
export const AppDevEnv = "MOLTENTERM_APP_DEV";

export function wavesrvChannelEnv(isPackaged: boolean, bakedChannel: string): Record<string, string> {
    return { [AppChannelEnv]: bakedChannel ?? "", [AppDevEnv]: isPackaged ? "" : "1" };
}

export function currentWavesrvChannelEnv(isPackaged: boolean): Record<string, string> {
    const baked = typeof __MOLTENTERM_CHANNEL__ === "undefined" ? "" : __MOLTENTERM_CHANNEL__;
    return wavesrvChannelEnv(isPackaged, baked);
}
