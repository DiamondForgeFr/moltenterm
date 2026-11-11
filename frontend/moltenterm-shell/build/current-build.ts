// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The build that runs, as the status bar and the About panel name it (FR-SHELL-008, FR-REL-001).

import { getApi } from "@/app/store/global";
import { GateChannel, gateChannel } from "./build-channel";
import type { MoltentermBuildInfo } from "./build-info";
import { brainstormAllowed, brainstormReplayAllowed, BuildIdentity, makeBuildIdentity } from "./build-identity";

export function readBuildInfo(): MoltentermBuildInfo {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

// The channel Mission Control's launcher set for a gold copy, if any.
export function readRuntimeChannel(): string {
    return getApi().getEnv("MOLTENTERM_CHANNEL");
}

export function currentBuildIdentity(version: string): BuildIdentity {
    return makeBuildIdentity(readBuildInfo(), {
        isDev: getApi().getIsDev(),
        runtimeChannel: readRuntimeChannel(),
        version,
    });
}

// The gate channel of the features a release does not have yet (build-channel.ts gateChannel): the baked channel, which
// the launcher's may only narrow. Read once, as it never changes while the app runs; null where it cannot be read (a
// test or the preview server without the Electron API): what a channel gates is then absent.
let channelRead = false;
let channel: GateChannel = null;

export function currentChannel(): GateChannel {
    if (!channelRead) {
        channelRead = true;
        try {
            channel = gateChannel({
                isDev: getApi().getIsDev(),
                runtimeChannel: readRuntimeChannel(),
                buildChannel: readBuildInfo()?.channel,
            });
        } catch (e) {
            console.log("build: the channel could not be read", e);
            channel = null;
        }
    }
    return channel;
}

// The window's lock of Brokk's thought in 3D (FR-BOSS-010 AC1), and of its scripted replay.
export function currentBrainstormGates(): { start: boolean; replay: boolean } {
    const now = currentChannel();
    return now == null
        ? { start: false, replay: false }
        : { start: brainstormAllowed(now), replay: brainstormReplayAllowed(now) };
}

export function currentBrainstormAllowed(): boolean {
    return currentBrainstormGates().start;
}
