// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which channel a build runs on (FR-REL-001), with no import: the window (build-identity.ts) and Electron main
// (emain/moltenterm-build-channel.ts, which gives it to wavesrv) decide it the same way, so the two locks of a feature
// that only some channels have never disagree (FR-BOSS-010 AC1, #2246).

export const BuildChannelNames = ["dev", "local", "gold", "rc", "public"] as const;

export type BuildChannelName = (typeof BuildChannelNames)[number];

export function isBuildChannelName(value: string): value is BuildChannelName {
    return (BuildChannelNames as readonly string[]).includes(value);
}

// The dev server wins, then a channel the launcher set (Mission Control marks a gold copy), then the build's own; an
// unknown name is a local build.
export function resolveBuildChannel(opts: {
    isDev: boolean;
    runtimeChannel?: string;
    buildChannel?: string;
}): BuildChannelName {
    if (opts.isDev) {
        return "dev";
    }
    const named = opts.runtimeChannel || opts.buildChannel || "local";
    return isBuildChannelName(named) ? named : "local";
}
