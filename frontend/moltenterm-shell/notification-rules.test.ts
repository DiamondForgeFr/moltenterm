// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    badgeCount,
    deliveryFor,
    deliveryOf,
    parsePrefs,
    shownEntries,
    subjectOf,
    toastArrivals,
} from "./notification-rules";
import { MoltentermNotification, unreadCount } from "./notifications-model";
import { overallProgress, WorkItem } from "./running-work";

function entry(id: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, source: "build", title: id, kind: "warning", time: 1, updated: 1, read: false, ...extra };
}

describe("notification toasts (FR-SHELL-055)", () => {
    it("names the new or changed notifications that are still unread, whatever their kind", () => {
        const seen = new Map([
            ["old", 1],
            ["changed", 1],
        ]);
        const entries = [
            entry("old"),
            entry("changed", { updated: 2 }),
            entry("new"),
            entry("info", { kind: "info" }),
            entry("done", { kind: "success" }),
            entry("read", { read: true }),
            entry("archived", { archived: 3 }),
            entry("resolved", { resolved: 3 }),
        ];
        expect(toastArrivals(entries, seen)).toEqual(["changed", "new", "info", "done"]);
    });
});

describe("notification preferences (FR-MC-019)", () => {
    it("files each source under its subject", () => {
        expect(subjectOf("agent")).toBe("agents");
        expect(subjectOf("build")).toBe("builds");
        expect(subjectOf("moltenterm")).toBe("updates");
        expect(subjectOf("mod")).toBe("mods");
        expect(subjectOf("deps")).toBe("dependencies");
        expect(subjectOf("unknown")).toBeNull();
    });

    it("keeps nothing of an agent once agents are off, errors aside (#409)", () => {
        const prefs = parsePrefs({
            agents: "off",
            builds: "off",
            ci: "off",
            releases: "off",
            mods: "off",
            dependencies: "off",
            updates: "notify",
        });
        for (const kind of ["warning", "success", "info", undefined] as const) {
            expect(deliveryOf({ source: "agent", kind }, prefs)).toBe("off");
        }
        expect(deliveryOf({ source: "agent", kind: "error" }, prefs)).toBe("notify");
        expect(deliveryOf({ source: "moltenterm", kind: "info" }, prefs)).toBe("notify");
    });

    it("lists and counts nothing of a subject turned off, errors aside, and no quiet item (#429)", () => {
        const prefs = parsePrefs({ agents: "off", ci: "quiet" });
        const entries = [
            entry("waiting", { source: "agent", kind: "warning" }),
            entry("done", { source: "agent", kind: "success" }),
            entry("failed", { source: "agent", kind: "error" }),
            entry("quiet", { source: "ci", kind: "info", read: true }),
            entry("update", { source: "moltenterm", kind: "info" }),
        ];
        const shown = shownEntries(entries, prefs);
        expect(shown.map((e) => e.id)).toEqual(["failed", "quiet", "update"]);
        expect(unreadCount(shown)).toBe(2);
    });

    it("caps the bell's count at 9+", () => {
        expect(badgeCount(0)).toBe("");
        expect(badgeCount(1)).toBe("1");
        expect(badgeCount(9)).toBe("9");
        expect(badgeCount(10)).toBe("9+");
        expect(badgeCount(250)).toBe("9+");
    });

    it("always tells errors and lets everything else follow the choice", () => {
        expect(deliveryFor("error", "off")).toBe("notify");
        expect(deliveryFor("warning", "off")).toBe("off");
        expect(deliveryFor("warning", "quiet")).toBe("quiet");
        expect(deliveryFor("info", "off")).toBe("off");
        expect(deliveryFor("success", "quiet")).toBe("quiet");
        expect(deliveryOf({ source: "build" }, { builds: "off" })).toBe("off");
        expect(deliveryOf({ source: "build", kind: "error" }, { builds: "off" })).toBe("notify");
        expect(deliveryOf({ source: "ci" }, { builds: "off" })).toBe("notify");
    });

    it("reads only valid choices", () => {
        expect(parsePrefs({ builds: "off", ci: "loud", agents: "quiet", other: "off" })).toEqual({
            builds: "off",
            agents: "quiet",
        });
        expect(parsePrefs("nope")).toEqual({});
        expect(parsePrefs(null)).toEqual({});
    });
});

describe("running work (FR-MC-019)", () => {
    const item = (progress: number): WorkItem => ({
        id: "x",
        kind: "build",
        dir: "/p",
        title: "x",
        startedat: 1,
        progress,
    });
    it("rings with the mean of the measured work, or turns when nothing is measured", () => {
        expect(overallProgress([])).toBeNull();
        expect(overallProgress([item(-1)])).toBeNull();
        expect(overallProgress([item(-1), item(0.5), item(1)])).toBe(0.75);
    });
});
