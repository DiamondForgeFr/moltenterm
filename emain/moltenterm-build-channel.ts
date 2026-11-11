// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The channel Electron main gives wavesrv at launch (FR-REL-001, FR-BOSS-010 AC1, #2246): wavesrv has no build facts of
// its own, and what exists only on some channels must be refused there too, not only hidden in the window. It is the
// channel the window computes (frontend/moltenterm-shell/build/build-identity.ts): the dev build, else the launcher's
// MOLTENTERM_CHANNEL, else the build's own.

import { BuildChannelName, resolveBuildChannel } from "../frontend/moltenterm-shell/build/build-channel";

declare const __MOLTENTERM_CHANNEL__: string;

// must match Env in pkg/molten/buildchannel/buildchannel.go
export const BuildChannelEnv = "MOLTENTERM_BUILD_CHANNEL";
// The launcher's channel, the one the window reads too (current-build.ts readRuntimeChannel).
export const RuntimeChannelEnv = "MOLTENTERM_CHANNEL";

export function buildChannelFor(
    isPackaged: boolean,
    env: Record<string, string | undefined>,
    buildChannel: string
): BuildChannelName {
    return resolveBuildChannel({ isDev: !isPackaged, runtimeChannel: env[RuntimeChannelEnv], buildChannel });
}

export function currentBuildChannel(isPackaged: boolean): BuildChannelName {
    const buildChannel = typeof __MOLTENTERM_CHANNEL__ === "undefined" ? "" : __MOLTENTERM_CHANNEL__;
    return buildChannelFor(isPackaged, process.env, buildChannel);
}
