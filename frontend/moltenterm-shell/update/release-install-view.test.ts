// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { ReleaseOffer } from "./release-feed";
import { ReleaseInstallPlan, ReleaseInstallState } from "./release-install";
import {
    announcementOf,
    canRetry,
    releaseCardView,
    releaseDownloadedKey,
    releaseFailedKey,
    releaseReadyKey,
} from "./release-install-view";

const offer: ReleaseOffer = {
    tag: "v1.0.0-9",
    version: "1.0.0-9",
    url: "https://github.com/x/y/releases/tag/v1.0.0-9",
    notes: "",
    publishedat: "",
};
const swap: ReleaseInstallPlan = { mode: "swap", kind: "zip" };
const idle: ReleaseInstallState = { phase: "idle" };
const available = (tag: string) => `release:available:${tag}`;

describe("the card of Settings › About", () => {
    it("shows the answer of the last check while the installer has nothing to do", () => {
        expect(releaseCardView(null, idle, swap, null)).toEqual({ kind: "none" });
        expect(releaseCardView(null, idle, swap, offer)).toEqual({ kind: "available", offer, plan: swap });
        expect(releaseCardView({ state: "checking" }, idle, swap, offer)).toEqual({ kind: "checking" });
        expect(releaseCardView({ state: "disabled" }, idle, swap, null)).toEqual({ kind: "disabled" });
        expect(releaseCardView({ state: "error", error: "x" }, idle, swap, null)).toEqual({ kind: "checkError" });
        expect(releaseCardView({ state: "latest", version: "1.0.0-8", checkedat: 5 }, idle, swap, null)).toEqual({
            kind: "latest",
            version: "1.0.0-8",
            checkedat: 5,
        });
        expect(releaseCardView({ state: "available", offer }, idle, swap, offer)).toEqual({
            kind: "available",
            offer,
            plan: swap,
        });
    });

    it("shows the installer's own states over the check, whichever the check said", () => {
        const latest = { state: "latest" as const, version: "1.0.0-8", checkedat: 5 };
        expect(
            releaseCardView(
                latest,
                { phase: "downloading", version: "1.0.0-9", percent: 40, mode: "swap" },
                swap,
                offer
            )
        ).toEqual({
            kind: "downloading",
            version: "1.0.0-9",
            percent: 40,
            mode: "swap",
        });
        expect(releaseCardView(latest, { phase: "verifying", version: "1.0.0-9" }, swap, offer)).toEqual({
            kind: "verifying",
            version: "1.0.0-9",
        });
        expect(
            releaseCardView(latest, { phase: "ready", version: "1.0.0-9", mode: "swap", armed: true }, swap, offer)
        ).toEqual({
            kind: "readySwap",
            version: "1.0.0-9",
        });
        expect(
            releaseCardView(
                latest,
                { phase: "ready", version: "1.0.0-9", mode: "download", file: "/d/x.deb" },
                swap,
                offer
            )
        ).toEqual({
            kind: "readyDownload",
            version: "1.0.0-9",
            file: "/d/x.deb",
        });
        expect(
            releaseCardView(latest, { phase: "error", version: "1.0.0-9", error: { kind: "checksum" } }, swap, offer)
        ).toEqual({ kind: "failed", version: "1.0.0-9", error: { kind: "checksum" }, retry: false, offer });
    });

    it("offers Try again only to a failure that trying again can cure", () => {
        for (const kind of ["network", "disk", "stale", "busy", "swap"] as const) {
            expect(canRetry({ kind }), kind).toBe(true);
        }
        for (const kind of [
            "signature",
            "checksum",
            "unsigned",
            "missing",
            "notapp",
            "codesign",
            "unpack",
            "toolarge",
            "unsupported",
        ] as const) {
            expect(canRetry({ kind }), kind).toBe(false);
        }
    });
});

describe("what a change of the installer's state announces", () => {
    it("closes the offer's message as soon as the user acts, and a failure of an earlier try with it", () => {
        const a = announcementOf(
            idle,
            { phase: "downloading", tag: "v1.0.0-9", version: "1.0.0-9", mode: "swap", percent: 0 },
            available
        );
        expect(a.resolve).toEqual([available("v1.0.0-9"), releaseFailedKey("v1.0.0-9")]);
        expect(a.tell).toBeUndefined();
        const again = announcementOf(
            { phase: "downloading", tag: "v1.0.0-9", mode: "swap", percent: 0 },
            { phase: "downloading", tag: "v1.0.0-9", mode: "swap", percent: 10 },
            available
        );
        expect(again.resolve).toEqual([]);
    });

    it("tells a staged update once, and a file downloaded by hand once", () => {
        const swapped = announcementOf(
            { phase: "verifying", tag: "v1.0.0-9" },
            { phase: "ready", tag: "v1.0.0-9", version: "1.0.0-9", mode: "swap", armed: true },
            available
        );
        expect(swapped.tell).toEqual({ kind: "ready", tag: "v1.0.0-9", version: "1.0.0-9" });
        expect(swapped.resolve).toEqual([available("v1.0.0-9")]);
        const downloaded = announcementOf(
            { phase: "verifying", tag: "v1.0.0-9" },
            { phase: "ready", tag: "v1.0.0-9", version: "1.0.0-9", mode: "download", file: "/d/x" },
            available
        );
        expect(downloaded.tell?.kind).toBe("downloaded");
        const repeated = announcementOf(
            { phase: "ready", tag: "v1.0.0-9", mode: "swap" },
            { phase: "ready", tag: "v1.0.0-9", version: "1.0.0-9", mode: "swap", armed: true },
            available
        );
        expect(repeated.tell).toBeUndefined();
    });

    it("tells a failure once, with whether trying again can help", () => {
        const failed = announcementOf(
            { phase: "downloading", tag: "v1.0.0-9" },
            { phase: "error", tag: "v1.0.0-9", version: "1.0.0-9", error: { kind: "signature", detail: "x" } },
            available
        );
        expect(failed.tell).toEqual({
            kind: "failed",
            tag: "v1.0.0-9",
            version: "1.0.0-9",
            error: { kind: "signature", detail: "x" },
            retry: false,
        });
        const network = announcementOf(
            { phase: "downloading", tag: "v1.0.0-9" },
            { phase: "error", tag: "v1.0.0-9", version: "1.0.0-9", error: { kind: "network" } },
            available
        );
        expect(network.tell?.retry).toBe(true);
    });

    it("withdraws every message of an update that went away", () => {
        const a = announcementOf({ phase: "ready", tag: "v1.0.0-9", mode: "swap" }, idle, available);
        expect(a.resolve).toEqual([
            releaseReadyKey("v1.0.0-9"),
            releaseDownloadedKey("v1.0.0-9"),
            releaseFailedKey("v1.0.0-9"),
        ]);
        expect(announcementOf(idle, idle, available)).toEqual({ resolve: [] });
    });
});
