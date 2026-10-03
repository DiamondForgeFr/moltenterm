// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the status bar shows (FR-SHELL-008), from the build facts and the running app.

import type { MoltentermBuildInfo } from "./build/build-info";

export type StatusBarChannel = "dev" | "local" | "gold" | "release";

// The dev channel's text colour, shared by the status bar badge and the widget bar's dev icon.
export const MoltentermDevChannelText = "text-sky-300";

export type StatusBarView = {
    channel: StatusBarChannel;
    channelLabel: string;
    branch: string;
    shortCommit: string;
    dirty: boolean;
    version: string;
    tooltip: string;
};

const ChannelLabels: Record<StatusBarChannel, string> = {
    dev: "dev",
    local: "local build",
    gold: "Gold",
    release: "release",
};

function asChannel(value: string): StatusBarChannel {
    return value in ChannelLabels ? (value as StatusBarChannel) : "local";
}

// The dev server wins, then a channel the launcher set (Mission Control marks a gold copy), then the build's own.
export function makeStatusBarView(
    build: MoltentermBuildInfo,
    opts: { isDev: boolean; runtimeChannel?: string; version: string }
): StatusBarView {
    const channel = opts.isDev ? "dev" : asChannel(opts.runtimeChannel || build?.channel || "local");
    const release = channel === "release";
    const tooltipLines = [`MoltenTerm ${opts.version}`];
    if (build?.builtAt) {
        tooltipLines.push(`built ${build.builtAt}`);
    }
    if (build?.commit) {
        tooltipLines.push(`commit ${build.commit}${build.dirty ? " (uncommitted changes)" : ""}`);
    }
    return {
        channel,
        channelLabel: ChannelLabels[channel],
        branch: release ? "" : (build?.branch ?? ""),
        shortCommit: release ? "" : (build?.shortCommit ?? ""),
        dirty: !release && !!build?.dirty,
        version: opts.version,
        tooltip: tooltipLines.join("\n"),
    };
}
