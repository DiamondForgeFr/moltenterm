// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which channel a build runs on (FR-REL-001), with no import, for the window (build-identity.ts) and Electron main
// (emain/moltenterm-build-channel.ts).
//
// Two answers. resolveBuildChannel is the channel a build names itself by (its badge, its updates): the launcher's
// channel wins there, as Mission Control marks a gold copy. gateChannel is the channel the features a release does not
// have yet follow (FR-BOSS-010 AC1, #2246): there the channel baked into the app decides, the launcher's may only narrow
// it, and an unknown name opens nothing. The window and wavesrv (pkg/molten/buildchannel GateChannel) apply the same
// rule, so the two locks never disagree.

export const BuildChannelNames = ["dev", "local", "gold", "rc", "public"] as const;

export type BuildChannelName = (typeof BuildChannelNames)[number];

// What gateChannel answers for a name that is not a channel: it opens nothing.
export type GateChannel = BuildChannelName | "unknown";

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

// How much of what is gated a channel opens: the brainstorm on gold, its scripted replay too on local and dev.
const GateReach: Record<BuildChannelName, number> = { rc: 0, public: 0, gold: 1, local: 2, dev: 2 };

// The gate channel: an unpackaged app is dev. Otherwise the baked channel decides: a release candidate or a public
// release stays one whatever the launcher says, a launcher's channel is followed only when it opens no more than the
// baked one (a gold copy marked rc, never a gold marked dev), and a name that is not a channel is "unknown". An app
// that names no baked channel is a local build, as build-info.ts bakes it. must match
// pkg/molten/buildchannel/buildchannel.go GateChannel.
export function gateChannel(opts: { isDev: boolean; runtimeChannel?: string; buildChannel?: string }): GateChannel {
    if (opts.isDev) {
        return "dev";
    }
    const baked = opts.buildChannel || "local";
    if (!isBuildChannelName(baked)) {
        return "unknown";
    }
    const runtime = opts.runtimeChannel ?? "";
    if (runtime === "" || baked === "rc" || baked === "public") {
        return baked;
    }
    if (!isBuildChannelName(runtime)) {
        return "unknown";
    }
    return GateReach[runtime] <= GateReach[baked] ? runtime : baked;
}
