// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    attentionArrivals,
    attentionDuration,
    deliveryFor,
    deliveryOf,
    deservesAttention,
    parsePrefs,
    subjectOf,
} from "./notification-rules";
import { MoltentermNotification } from "./notifications-model";
import { overallProgress, WorkItem } from "./running-work";

function entry(id: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, source: "build", title: id, kind: "warning", time: 1, updated: 1, read: false, ...extra };
}

describe("notification attention (FR-MC-019)", () => {
    it("opens only for what asks for a decision, for 2 to 5 seconds", () => {
        expect(deservesAttention("error")).toBe(true);
        expect(deservesAttention("warning")).toBe(true);
        expect(deservesAttention("info")).toBe(false);
        expect(deservesAttention("success")).toBe(false);
        expect(attentionDuration(0)).toBe(2000);
        expect(attentionDuration(1)).toBe(2000);
        expect(attentionDuration(3)).toBe(3400);
        expect(attentionDuration(20)).toBe(5000);
    });

    it("names the new or changed warnings and errors that are still unread", () => {
        const seen = new Map([
            ["old", 1],
            ["changed", 1],
        ]);
        const entries = [
            entry("old"),
            entry("changed", { updated: 2 }),
            entry("new"),
            entry("info", { kind: "info" }),
            entry("read", { read: true }),
            entry("archived", { archived: 3 }),
            entry("resolved", { resolved: 3 }),
        ];
        expect(attentionArrivals(entries, seen)).toEqual(["changed", "new"]);
    });
});

describe("notification preferences (FR-MC-019)", () => {
    it("files each source under its subject", () => {
        expect(subjectOf("agent")).toBe("agents");
        expect(subjectOf("build")).toBe("builds");
        expect(subjectOf("moltenterm")).toBe("updates");
        expect(subjectOf("mod")).toBe("mods");
        expect(subjectOf("unknown")).toBeNull();
    });

    it("always tells errors, keeps warnings at worst, and lets information follow the choice", () => {
        expect(deliveryFor("error", "off")).toBe("notify");
        expect(deliveryFor("warning", "off")).toBe("quiet");
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
