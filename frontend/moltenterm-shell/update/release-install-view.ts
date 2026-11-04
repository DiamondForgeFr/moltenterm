// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Settings › About and the notifications say about the in-app update of a release (#1860): which of the card's
// states the app is in, given the last check and the installer's state, and what a change of that state announces.
// Pure, so the rules are tested without the interface (Notulia keeps its update rules apart for the same reason).

import { ReleaseOffer, UpdateCheckState } from "./release-feed";
import {
    ReleaseInstallError,
    ReleaseInstallErrorKind,
    ReleaseInstallPlan,
    ReleaseInstallState,
} from "./release-install";

// What the Check for updates action shows while it asks, then its answer (#1806).
export type UpdateCheckView = UpdateCheckState | { state: "checking" };

export type ReleaseCardView =
    | { kind: "none" }
    | { kind: "checking" }
    | { kind: "disabled" }
    | { kind: "checkError" }
    | { kind: "latest"; version: string; checkedat: number }
    | { kind: "available"; offer: ReleaseOffer; plan: ReleaseInstallPlan }
    | { kind: "downloading"; version: string; percent?: number; mode: ReleaseInstallPlan["mode"] }
    | { kind: "verifying"; version: string }
    | { kind: "readySwap"; version: string }
    | { kind: "readyDownload"; version: string; file: string }
    | { kind: "failed"; version: string; error: ReleaseInstallError; retry: boolean; offer: ReleaseOffer };

// A failure that trying again can cure: the network, the disk, an offer that moved on. The others (a signature, a
// checksum, a bad app) give the same answer every time, so offering the click would suggest they are passing: the
// release page has the files (Notulia's rule, #282).
const RetryableErrors: ReadonlySet<ReleaseInstallErrorKind> = new Set(["network", "disk", "stale", "busy", "swap"]);

export function canRetry(error: ReleaseInstallError): boolean {
    return RetryableErrors.has(error?.kind);
}

// The install's own states take the card while it is at work on the offer; otherwise the answer of the last check shows.
export function releaseCardView(
    check: UpdateCheckView,
    install: ReleaseInstallState,
    plan: ReleaseInstallPlan,
    offer: ReleaseOffer
): ReleaseCardView {
    const version = install?.version ?? "";
    switch (install?.phase) {
        case "downloading":
            return { kind: "downloading", version, percent: install.percent, mode: install.mode };
        case "verifying":
            return { kind: "verifying", version };
        case "ready":
            return install.mode === "swap"
                ? { kind: "readySwap", version }
                : { kind: "readyDownload", version, file: install.file ?? "" };
        case "error":
            return { kind: "failed", version, error: install.error, retry: canRetry(install.error), offer };
    }
    if (check == null) {
        return offer == null ? { kind: "none" } : { kind: "available", offer, plan };
    }
    switch (check.state) {
        case "checking":
            return { kind: "checking" };
        case "disabled":
            return { kind: "disabled" };
        case "error":
            return { kind: "checkError" };
        case "available":
            return { kind: "available", offer: check.offer, plan };
        case "latest":
            return { kind: "latest", version: check.version, checkedat: check.checkedat };
    }
}

export function releaseReadyKey(tag: string): string {
    return `release:ready:${tag}`;
}

export function releaseFailedKey(tag: string): string {
    return `release:failed:${tag}`;
}

export function releaseDownloadedKey(tag: string): string {
    return `release:downloaded:${tag}`;
}

// What a change of the installer's state puts in the notification center: situations no longer true are resolved, and
// a state the user must hear of is told once (the keys make a repeat update in place, as Notulia's do).
export type InstallAnnouncement = {
    resolve: string[];
    tell?: {
        kind: "ready" | "downloaded" | "failed";
        tag: string;
        version: string;
        error?: ReleaseInstallError;
        retry?: boolean;
    };
};

export function announcementOf(
    prev: ReleaseInstallState,
    next: ReleaseInstallState,
    availableKey: (tag: string) => string
): InstallAnnouncement {
    const resolve: string[] = [];
    // The user acted on the offer: the situation "an update is waiting" is over, and so is a failure of an earlier try.
    if (next.phase === "downloading" && next.tag != null && prev?.phase !== "downloading") {
        resolve.push(availableKey(next.tag), releaseFailedKey(next.tag));
    }
    // A staged update that went away (a newer release, the preference turned off) takes its messages with it.
    if (next.phase === "idle" && prev?.tag != null) {
        resolve.push(releaseReadyKey(prev.tag), releaseDownloadedKey(prev.tag), releaseFailedKey(prev.tag));
    }
    if (next.phase === "ready" && prev?.phase !== "ready" && next.tag != null) {
        resolve.push(availableKey(next.tag));
        return {
            resolve,
            tell: {
                kind: next.mode === "swap" ? "ready" : "downloaded",
                tag: next.tag,
                version: next.version ?? "",
            },
        };
    }
    if (next.phase === "error" && prev?.phase !== "error" && next.tag != null) {
        return {
            resolve,
            tell: {
                kind: "failed",
                tag: next.tag,
                version: next.version ?? "",
                error: next.error,
                retry: canRetry(next.error),
            },
        };
    }
    return { resolve };
}
