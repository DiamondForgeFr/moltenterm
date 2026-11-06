// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { DownloadRecord } from "../downloads/downloads-model";
import type { UsageReadings } from "./boss-usage";
import {
    acknowledgeDownloads,
    acknowledgeUsage,
    downloadEventsOf,
    hotProviders,
    makeDownloadsMemory,
    updateEventsOf,
    usageEventsAfter,
    UsageThresholdPercent,
} from "./brokk-extra-feeds";

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
