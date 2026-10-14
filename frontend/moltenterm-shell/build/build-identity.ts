// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How a Moltenterm build names itself (FR-REL-001), for the status bar badge and the About panel. As in Notulia
// (localIdentity, #1000): a gold IS a version of its own, so a local build is named by its channel, build id and
// commit, and only a release candidate or a public release shows its version number in the badge.

import { MoltentermWaveBaseVersion } from "@/util/moltenterm-identity";
import { t } from "../i18n/i18n";
import type { MoltentermBuildInfo } from "./build-info";

export type BuildChannel = "dev" | "local" | "gold" | "rc" | "public";

// The channels (the keys are compared); their labels are build.channels.<channel>, translated where shown.
export const BuildChannelLabels: Record<BuildChannel, string> = {
    dev: "dev",
    local: "local build",
    gold: "Gold",
    rc: "release candidate",
    public: "release",
};

export function buildChannelLabel(channel: BuildChannel): string {
    return t(`build.channels.${channel}`);
}

export type BuildIdentity = {
    channel: BuildChannel;
    channelLabel: string;
    version: string;
    // What the status bar badge says: the channel for a local build, the version for a release.
    badge: string;
    // "Gold · build 1790928000 · 3 changes since v1.0.0-2"
    buildLine: string;
    // "commit a4e3b72 on develop (uncommitted changes)", or "".
    commitLine: string;
    waveBase: string;
};

export function asBuildChannel(value: string): BuildChannel {
    return value in BuildChannelLabels ? (value as BuildChannel) : "local";
}

export function isReleaseChannel(channel: BuildChannel): boolean {
    return channel === "rc" || channel === "public";
}

function changesLine(build: MoltentermBuildInfo): string {
    const count = build?.changesSinceRelease ?? -1;
    if (!build?.releaseTag) {
        return count >= 0 || build?.commit ? t("build.noReleaseYet") : "";
    }
    if (count < 0) {
        return t("build.after", { tag: build.releaseTag });
    }
    if (count === 0) {
        return t("build.exactly", { tag: build.releaseTag });
    }
    return count === 1
        ? t("build.changesSinceOne", { tag: build.releaseTag })
        : t("build.changesSinceOther", { count, tag: build.releaseTag });
}

// The dev server wins, then a channel the launcher set (Mission Control marks a gold copy), then the build's own.
// version is the one wavesrv reports, else the one stamped at build time.
export function makeBuildIdentity(
    build: MoltentermBuildInfo,
    opts: { isDev: boolean; runtimeChannel?: string; version?: string }
): BuildIdentity {
    const channel: BuildChannel = opts.isDev ? "dev" : asBuildChannel(opts.runtimeChannel || build?.channel || "local");
    const version = opts.version || build?.version || "";
    const channelLabel = buildChannelLabel(channel);
    const buildLine = [channelLabel, build?.buildId ? t("build.buildId", { id: build.buildId }) : "", changesLine(build)]
        .filter((s) => s)
        .join(" · ");
    let commitLine = "";
    if (build?.commit) {
        const commit = build.shortCommit || build.commit.slice(0, 7);
        commitLine = build.branch
            ? t("build.commitOnBranch", { commit, branch: build.branch })
            : t("build.commit", { commit });
        if (build.dirty) {
            commitLine = t("build.dirty", { line: commitLine });
        }
    }
    return {
        channel,
        channelLabel,
        version,
        badge: isReleaseChannel(channel) && version ? version : channelLabel,
        buildLine,
        commitLine,
        waveBase: MoltentermWaveBaseVersion,
    };
}
