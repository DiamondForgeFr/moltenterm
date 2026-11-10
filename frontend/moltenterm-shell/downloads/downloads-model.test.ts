// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    clearedRecords,
    connectionOfRemoteUri,
    DownloadRecord,
    downloadRingOf,
    extensionOf,
    groupDownloads,
    hasExecuteBit,
    hostOf,
    interruptionReason,
    isExecutableName,
    MaxDownloadAgeMs,
    MaxDownloadEntries,
    overallDownloadProgress,
    parseRecord,
    percentOf,
    pruneRecords,
    restoreRecords,
    rowActions,
    runningDownloads,
    safeFileName,
    secondsLeft,
    uniqueFileName,
} from "./downloads-model";

const Day = 24 * 60 * 60 * 1000;

function record(over: Partial<DownloadRecord> = {}): DownloadRecord {
    return {
        id: "a",
        url: "https://example.com/report.pdf",
        host: "example.com",
        name: "report.pdf",
        path: "/dl/report.pdf",
        mime: "application/pdf",
        state: "completed",
        received: 100,
        total: 100,
        bytesPerSecond: 0,
        startedAt: 1000,
        endedAt: 2000,
        reason: "",
        executable: false,
        missing: false,
        agent: "",
        workspaceId: "ws",
        tabId: "tab",
        blockId: "blk",
        browserTabId: "bt",
        pageUrl: "https://example.com/files",
        pageTitle: "Files",
        ...over,
    };
}

describe("what is a program (Q4)", () => {
    it("tells programs, installers, scripts, shortcuts and disk images from documents and archives", () => {
        for (const name of [
            "setup.exe",
            "tool.pkg",
            "run.sh",
            "Install.COMMAND",
            "a.ps1",
            "x.desktop",
            "disk.dmg",
            "disk.iso",
            "app.AppImage",
        ]) {
            expect(isExecutableName(name), name).toBe(true);
        }
        for (const name of [
            "report.pdf",
            "photos.zip",
            "notes.txt",
            "archive.tar.gz",
            "image.png",
            "no-extension",
            ".bashrc",
            "end.",
        ]) {
            expect(isExecutableName(name), name).toBe(false);
        }
    });

    it("reads the last extension, past trailing dots and spaces some systems drop", () => {
        expect(extensionOf("report.pdf.exe")).toBe("exe");
        expect(extensionOf("setup.exe. ")).toBe("exe");
        expect(isExecutableName("invoice.pdf.exe")).toBe(true);
        expect(isExecutableName("setup.exe...")).toBe(true);
    });

    it("sees the execute permission on a file with no known extension", () => {
        expect(hasExecuteBit(0o755)).toBe(true);
        expect(hasExecuteBit(0o644)).toBe(false);
        expect(hasExecuteBit(0o100)).toBe(true);
        expect(hasExecuteBit(NaN)).toBe(false);
    });
});

describe("the bounded history (Q5)", () => {
    it("keeps at most 200 entries, the newest, and never prunes what runs", () => {
        const closed = Array.from({ length: 230 }, (_, i) =>
            record({ id: `c${i}`, startedAt: 1_000_000 + i, endedAt: 1_000_100 + i })
        );
        const running = record({ id: "run", state: "progressing", startedAt: 1, endedAt: 0 });
        const kept = pruneRecords([...closed, running], 1_100_000);
        expect(kept.length).toBe(MaxDownloadEntries);
        expect(kept.some((r) => r.id === "run")).toBe(true);
        expect(kept.some((r) => r.id === "c229")).toBe(true);
        expect(kept.some((r) => r.id === "c0")).toBe(false);
    });

    it("drops what ended more than 90 days ago", () => {
        const now = 200 * Day;
        const old = record({
            id: "old",
            startedAt: now - MaxDownloadAgeMs - Day,
            endedAt: now - MaxDownloadAgeMs - Day,
        });
        const fresh = record({ id: "fresh", startedAt: now - Day, endedAt: now - Day });
        expect(pruneRecords([old, fresh], now).map((r) => r.id)).toEqual(["fresh"]);
    });

    it("keeps a download in progress however old it started", () => {
        const now = 400 * Day;
        const running = record({ id: "run", state: "paused", startedAt: 1, endedAt: 0 });
        expect(pruneRecords([running], now).map((r) => r.id)).toEqual(["run"]);
    });

    it("tells what was in progress when MoltenTerm quit as interrupted, with the reason", () => {
        const file = {
            version: 1,
            items: [
                record({ id: "was-running", state: "progressing", endedAt: 0 }),
                record({ id: "was-paused", state: "paused", endedAt: 0 }),
                record({ id: "done" }),
            ],
        };
        const restored = restoreRecords(file, 5000);
        const byId = Object.fromEntries(restored.map((r) => [r.id, r]));
        expect(byId["was-running"].state).toBe("interrupted");
        expect(byId["was-running"].reason).toBe("appclosed");
        expect(byId["was-running"].endedAt).toBe(5000);
        expect(byId["was-paused"].state).toBe("interrupted");
        expect(byId["done"].state).toBe("completed");
    });

    it("reads anything unreadable as an empty history, and drops the entries it cannot read", () => {
        expect(restoreRecords(null, 1)).toEqual([]);
        expect(restoreRecords({ items: "no" }, 1)).toEqual([]);
        expect(
            restoreRecords({ items: [null, 3, { id: "x" }, { id: "y", state: "weird" }, record({ id: "ok" })] }, 1).map(
                (r) => r.id
            )
        ).toEqual(["ok"]);
        expect(parseRecord({ id: "z", state: "completed", name: 5 }).name).toBe("");
    });

    it("clears what is over and nothing that runs", () => {
        const items = [
            record({ id: "a" }),
            record({ id: "b", state: "interrupted" }),
            record({ id: "c", state: "progressing" }),
        ];
        const { kept, removed } = clearedRecords(items);
        expect(kept.map((r) => r.id)).toEqual(["c"]);
        expect(removed).toBe(2);
    });
});

describe("what a row says", () => {
    it("invents no percentage when the site gives no size", () => {
        expect(percentOf(record({ received: 40, total: 0 }))).toBeNull();
        expect(percentOf(record({ received: 40, total: 100 }))).toBe(40);
        expect(percentOf(record({ received: 140, total: 100 }))).toBe(100);
    });

    it("tells the time left only while it progresses at a known speed", () => {
        expect(secondsLeft(record({ state: "progressing", received: 400, total: 1000, bytesPerSecond: 100 }))).toBe(6);
        expect(secondsLeft(record({ state: "paused", received: 400, total: 1000, bytesPerSecond: 100 }))).toBeNull();
        expect(secondsLeft(record({ state: "progressing", received: 400, total: 0, bytesPerSecond: 100 }))).toBeNull();
        expect(secondsLeft(record({ state: "progressing", received: 400, total: 1000, bytesPerSecond: 0 }))).toBeNull();
    });

    it("averages the ring over what is measured, and has no ring when nothing is", () => {
        const a = record({ id: "a", state: "progressing", received: 50, total: 100 });
        const b = record({ id: "b", state: "progressing", received: 100, total: 200 });
        const unknown = record({ id: "c", state: "progressing", received: 10, total: 0 });
        const paused = record({ id: "d", state: "paused", received: 99, total: 100 });
        expect(overallDownloadProgress([a, b, unknown, paused])).toBeCloseTo(0.5);
        expect(overallDownloadProgress([unknown, paused])).toBeNull();
    });

    it("gives Brokk's face the rail's ring: the overall progress of what runs, -1 while none knows its size, none when nothing runs (#2083)", () => {
        const a = record({ id: "a", state: "progressing", received: 50, total: 100 });
        const b = record({ id: "b", state: "progressing", received: 100, total: 200 });
        const unknown = record({ id: "c", state: "progressing", received: 10, total: 0 });
        expect(downloadRingOf(runningDownloads([a, b]))).toBeCloseTo(0.5);
        expect(downloadRingOf(runningDownloads([unknown]))).toBe(-1);
        expect(downloadRingOf(runningDownloads([record({ state: "completed" })]))).toBeNull();
        expect(downloadRingOf(runningDownloads([record({ state: "interrupted", received: 5, total: 10 })]))).toBeNull();
    });

    it("says why an interruption happened from what arrived", () => {
        expect(interruptionReason(0, false)).toBe("server");
        expect(interruptionReason(500, false)).toBe("connection");
        expect(interruptionReason(500, true)).toBe("noresume");
    });

    it("offers only what can work: a file that is gone offers Download again, never Open", () => {
        const present = rowActions(record());
        expect(present).toMatchObject({ open: true, reveal: true, redownload: false, copyLink: true, remove: true });
        const gone = rowActions(record({ missing: true }));
        expect(gone).toMatchObject({ open: false, reveal: false, redownload: true, remove: true });
        const running = rowActions(record({ state: "progressing" }));
        expect(running).toMatchObject({ pause: true, resume: false, cancel: true, remove: false, open: false });
        const paused = rowActions(record({ state: "paused" }));
        expect(paused).toMatchObject({ pause: false, resume: true, cancel: true });
        expect(rowActions(record({ state: "interrupted" }))).toMatchObject({ retry: true, open: false });
        expect(rowActions(record({ state: "cancelled" }))).toMatchObject({ retry: true, remove: true });
    });

    it("groups what runs first, then the closed ones by day", () => {
        const now = new Date(2026, 10, 6, 15, 0, 0).getTime();
        const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();
        const groups = groupDownloads(
            [
                record({ id: "old", startedAt: at(3, 9) }),
                record({ id: "y", startedAt: at(5, 9) }),
                record({ id: "t1", startedAt: at(6, 9) }),
                record({ id: "t2", startedAt: at(6, 11) }),
                record({ id: "run", state: "progressing", startedAt: at(6, 12) }),
            ],
            now
        );
        expect(groups.running.map((r) => r.id)).toEqual(["run"]);
        expect(groups.days.map((d) => d.kind)).toEqual(["today", "yesterday", "date"]);
        expect(groups.days[0].items.map((r) => r.id)).toEqual(["t2", "t1"]);
    });
});

describe("names", () => {
    it("never creates a name with a separator, a control character or nothing at all", () => {
        expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
        expect(safeFileName("a/b\\c:d.txt")).toBe("a_b_c_d.txt");
        expect(safeFileName("\u0001\u0002")).toBe("__");
        expect(safeFileName("...")).toBe("download");
        expect(safeFileName("")).toBe("download");
        expect(safeFileName(".hidden")).toBe("hidden");
        expect(safeFileName("x".repeat(400) + ".pdf").length).toBeLessThanOrEqual(200);
        expect(safeFileName("x".repeat(400) + ".pdf").endsWith(".pdf")).toBe(true);
    });

    it("never replaces another file: report.pdf taken gives report (1).pdf, then (2)", () => {
        const taken = new Set(["report.pdf", "report (1).pdf"]);
        expect(uniqueFileName("report.pdf", (c) => taken.has(c))).toBe("report (2).pdf");
        expect(uniqueFileName("fresh.pdf", (c) => taken.has(c))).toBe("fresh.pdf");
        expect(uniqueFileName("README", (c) => c === "README")).toBe("README (1)");
    });

    it("a Files panel download names its connection, keeps its kind across a restart and offers no Copy link (#2163)", () => {
        expect(connectionOfRemoteUri("wsh://dev-box/home/dev/report.pdf")).toBe("dev-box");
        expect(connectionOfRemoteUri("wsh://local/tmp/a.txt")).toBe("local");
        expect(connectionOfRemoteUri("/tmp/a.txt")).toBe("");
        const files = record({ source: "files", url: "http://127.0.0.1:5000/wave/stream-file/a.pdf?path=x" });
        expect(parseRecord(files).source).toBe("files");
        expect(parseRecord(record()).source).toBe("web");
        expect(rowActions(files).copyLink).toBe(false);
        expect(rowActions(files).open).toBe(true);
        expect(rowActions(record()).copyLink).toBe(true);
    });

    it("shows the host of a web address and nothing for another scheme", () => {
        expect(hostOf("https://www.example.com:8443/a/b?c=d")).toBe("example.com:8443");
        expect(hostOf("blob:https://example.com/uuid")).toBe("");
        expect(hostOf("not a url")).toBe("");
    });
});
