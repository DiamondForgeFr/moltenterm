// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreRecords, type DownloadRecord } from "../frontend/moltenterm-shell/downloads/downloads-model";
import { DownloadStore } from "./moltenterm-download-store";

const folders: string[] = [];

function folder(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-downloads-"));
    folders.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of folders.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function record(over: Partial<DownloadRecord> = {}): DownloadRecord {
    return {
        id: "a",
        url: "https://example.com/a.pdf",
        host: "example.com",
        name: "a.pdf",
        path: "/dl/a.pdf",
        mime: "application/pdf",
        state: "completed",
        received: 10,
        total: 10,
        bytesPerSecond: 99,
        startedAt: 1,
        endedAt: 2,
        reason: "",
        executable: false,
        missing: true,
        agent: "Jérôme",
        workspaceId: "ws",
        tabId: "tab",
        blockId: "blk",
        browserTabId: "bt",
        pageUrl: "https://example.com",
        pageTitle: "Example",
        ...over,
    };
}

describe("the downloads' history on disk (FR-MC-019 AC11)", () => {
    it("survives a restart, with where each download came from, and keeps nothing that is only measured live", async () => {
        const dir = folder();
        const store = new DownloadStore(path.join(dir, "downloads"));
        await store.save([record(), record({ id: "b", state: "progressing", endedAt: 0 })]);
        const restored = restoreRecords(await new DownloadStore(path.join(dir, "downloads")).load(), 10);
        expect(restored.map((r) => r.id).sort()).toEqual(["a", "b"]);
        const a = restored.find((r) => r.id === "a");
        expect(a).toMatchObject({
            agent: "Jérôme",
            workspaceId: "ws",
            tabId: "tab",
            blockId: "blk",
            browserTabId: "bt",
            pageUrl: "https://example.com",
            pageTitle: "Example",
            bytesPerSecond: 0,
            missing: false,
        });
        expect(restored.find((r) => r.id === "b")).toMatchObject({ state: "interrupted", reason: "appclosed" });
    });

    it("starts empty when there is no file or it cannot be read", async () => {
        const dir = folder();
        const store = new DownloadStore(path.join(dir, "downloads"));
        expect(await store.load()).toBeNull();
        fs.mkdirSync(path.join(dir, "downloads"));
        fs.writeFileSync(path.join(dir, "downloads", "downloads.json"), "{ not json");
        expect(await store.load()).toBeNull();
        expect(restoreRecords(await store.load(), 1)).toEqual([]);
    });

    it("writes atomically: no temporary file is left behind", async () => {
        const dir = folder();
        const store = new DownloadStore(path.join(dir, "downloads"));
        await store.save([record()]);
        store.saveSync([record(), record({ id: "c" })]);
        expect(fs.readdirSync(path.join(dir, "downloads"))).toEqual(["downloads.json"]);
        expect(restoreRecords(await store.load(), 10).length).toBe(2);
    });
});
