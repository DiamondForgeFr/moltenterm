// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { DownloadRecord } from "../downloads/downloads-model";
import type { UsageReadings } from "./boss-usage";
import {
    acknowledgeDownloads,
    downloadEventsOf,
    makeDownloadsMemory,
    updateEventsOf,
    UsageThresholdPercent,
} from "./brokk-extra-feeds";
import { acknowledgeUsage, hotProviders, usageEventsAfter } from "./brokk-usage-visit";

const Now = new Date(2026, 10, 6, 10, 0, 0).getTime();

function download(id: string, state: DownloadRecord["state"], endedAt: number): DownloadRecord {
    return { id, state, endedAt } as DownloadRecord;
}

function reading(agent: string, percents: number[], readat = Now): UsageReadings[string] {
    return {
        agent,
        source: "test",
        readat,
        windows: percents.map((usedpercent, i) => ({ id: `w${i}`, label: `w${i}`, usedpercent })),
    };
}

describe("the downloads feed the visit model (FR-BOSS-009, AC11)", () => {
    it("raises a finished and a failed download that ended after the window began listening", () => {
        const memory = makeDownloadsMemory(Now);
        const events = downloadEventsOf(memory, [
            download("a", "completed", Now + 5),
            download("b", "interrupted", Now + 6),
        ]);
        expect(events).toEqual([
            { key: "download:a", kind: "downloadfinished", since: Now + 5 },
            { key: "download:b", kind: "downloadfailed", since: Now + 6 },
        ]);
    });

    it("tells nothing of the history that loads after the window began, nor of a download in progress or cancelled", () => {
        const memory = makeDownloadsMemory(Now);
        expect(
            downloadEventsOf(memory, [
                download("old", "completed", Now - 60_000),
                download("run", "progressing", 0),
                download("paused", "paused", 0),
                download("cancelled", "cancelled", Now + 1),
            ])
        ).toEqual([]);
    });

    it("raises a download when it ends, not while it progresses", () => {
        const memory = makeDownloadsMemory(Now);
        expect(downloadEventsOf(memory, [download("a", "progressing", 0)])).toEqual([]);
        expect(downloadEventsOf(memory, [download("a", "completed", Now + 9)])).toHaveLength(1);
    });

    it("forgets what the developer saw by opening Brokk, and raises the next one", () => {
        let memory = makeDownloadsMemory(Now);
        const first = [download("a", "completed", Now + 5)];
        expect(downloadEventsOf(memory, first)).toHaveLength(1);
        memory = acknowledgeDownloads(memory, first);
        expect(downloadEventsOf(memory, first)).toEqual([]);
        const second = [...first, download("b", "interrupted", Now + 50)];
        expect(downloadEventsOf(memory, second).map((e) => e.key)).toEqual(["download:b"]);
    });

    it("cancels the event of a download removed from the list", () => {
        const memory = makeDownloadsMemory(Now);
        expect(downloadEventsOf(memory, [download("a", "completed", Now + 5)])).toHaveLength(1);
        expect(downloadEventsOf(memory, [])).toEqual([]);
    });
});

describe("the update notice feeds the visit model", () => {
    it("raises the update on offer until the developer has seen that very one", () => {
        expect(updateEventsOf("gold:12", "")).toEqual([{ key: "update:gold:12", kind: "update", since: 0 }]);
        expect(updateEventsOf("gold:12", "gold:12")).toEqual([]);
        expect(updateEventsOf("gold:13", "gold:12")).toHaveLength(1);
    });

    it("raises nothing when no update is on offer", () => {
        expect(updateEventsOf("", "")).toEqual([]);
        expect(updateEventsOf("", "gold:12")).toEqual([]);
    });
});

describe("the plan usage feeds the visit model", () => {
    it("names the providers at the line or above it, by their fullest window", () => {
        const readings: UsageReadings = {
            claude: reading("claude", [40, UsageThresholdPercent]),
            codex: reading("codex", [89.9]),
        };
        expect(hotProviders(readings, Now)).toEqual(["claude"]);
    });

    it("takes the provider's latest reading when several agents share one plan", () => {
        const readings: UsageReadings = {
            a: reading("claude", [95], Now - 1000),
            b: reading("claude", [10], Now),
        };
        expect(hotProviders(readings, Now)).toEqual([]);
    });

    it("drops a window past its reset", () => {
        const readings: UsageReadings = {
            claude: {
                ...reading("claude", []),
                windows: [{ id: "w", label: "w", usedpercent: 99, resetsat: Now - 1 }],
            },
        };
        expect(hotProviders(readings, Now)).toEqual([]);
    });

    // #2341, AC96: a reading older than its window is no news, a full one least of all.
    it("ignores a reading older than its window or than 7 days", () => {
        const Day = 24 * 60 * 60 * 1000;
        const monthly = (readat: number): UsageReadings[string] => ({
            agent: "codex",
            source: "test",
            readat,
            windows: [
                { id: "window:43200", label: "30-day", usedpercent: 100, resetsat: Now + 20 * Day, windowmins: 43200 },
            ],
        });
        expect(hotProviders({ codex: monthly(Now - Day) }, Now)).toEqual(["codex"]);
        expect(hotProviders({ codex: monthly(Now - 8 * Day) }, Now)).toEqual([]);
        expect(usageEventsAfter({ seen: new Set() }, { codex: monthly(Now - 8 * Day) }, Now).events).toEqual([]);
    });

    // #2341, AC95 and AC97: what the grid does not show never calls him.
    describe("a provider the grid does not show", () => {
        const none = { show: [], hide: [] };
        const hot = (agent: string) => ({ [agent]: reading(agent, [95]) });

        it("never brings him once the developer chose to hide it, and brings him again when it shows", () => {
            const readings = hot("claude");
            expect(hotProviders(readings, Now, { use: {}, choices: none })).toEqual(["claude"]);
            expect(hotProviders(readings, Now, { use: {}, choices: { show: [], hide: ["claude"] } })).toEqual([]);
            expect(hotProviders(readings, Now, { use: null, choices: { show: [], hide: ["claude"] } })).toEqual([]);
            expect(hotProviders(readings, Now, { choices: { show: ["claude"], hide: [] } })).toEqual(["claude"]);
            const hidden = usageEventsAfter({ seen: new Set() }, readings, Now, {
                choices: { show: [], hide: ["claude"] },
            });
            expect(hidden.events).toEqual([]);
        });

        it("never brings him when it was not used for 7 days and its plan is not paid", () => {
            // A reading with no time: it is not stale, but nothing was read in the last 7 days and nobody used it.
            const readings = { codex: reading("codex", [99], 0) };
            expect(hotProviders(readings, Now)).toEqual(["codex"]);
            expect(hotProviders(readings, Now, { use: {}, choices: none })).toEqual([]);
            const used = { use: { codex: { workms: 0, sessions: 1, lastat: Now } }, choices: none };
            expect(hotProviders(readings, Now, used)).toEqual(["codex"]);
            const paid = { codex: { ...reading("codex", [99], 0), plan: "plus" } };
            expect(hotProviders(paid, Now, { use: {}, choices: none })).toEqual(["codex"]);
        });

        it("keeps what he had seen of it while it is hidden, so showing it again is no news", () => {
            const readings = hot("claude");
            const seen = acknowledgeUsage(readings, Now);
            const hide = { choices: { show: [], hide: ["claude"] } };
            const step = usageEventsAfter(seen, readings, Now, hide);
            expect(step.memory).toBe(seen);
            expect(usageEventsAfter(step.memory, readings, Now).events).toEqual([]);
            expect(acknowledgeUsage(readings, Now, seen, hide).seen.has("claude")).toBe(true);
        });

        it("leaves the others to call him", () => {
            const readings = { ...hot("claude"), ...hot("codex") };
            const step = usageEventsAfter({ seen: new Set() }, readings, Now, {
                choices: { show: [], hide: ["claude"] },
            });
            expect(step.events.map((e) => e.key)).toEqual(["usage:codex"]);
        });
    });

    it("raises a provider that crosses the line, once the developer has not seen it", () => {
        const step = usageEventsAfter({ seen: new Set() }, { claude: reading("claude", [92]) }, Now);
        expect(step.events).toEqual([{ key: "usage:claude", kind: "usage", since: 0 }]);
    });

    it("stops raising a provider the developer saw, and raises it again after it fell below the line", () => {
        const hot = { claude: reading("claude", [92]) };
        const seen = acknowledgeUsage(hot, Now);
        expect(usageEventsAfter(seen, hot, Now).events).toEqual([]);
        const fell = usageEventsAfter(seen, { claude: reading("claude", [30]) }, Now);
        expect(fell.events).toEqual([]);
        expect(usageEventsAfter(fell.memory, hot, Now).events).toHaveLength(1);
    });
});
