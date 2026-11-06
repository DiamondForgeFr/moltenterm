// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    faviconFileName,
    FaviconFreshMs,
    FaviconIndexName,
    FaviconMaxBytes,
    FaviconStore,
} from "./moltenterm-favicon-store";

// The clock only moves when a test moves it: nothing here depends on how fast the machine is.
let now = 1_000_000;
const clock = () => now;

function png(size: number, fill = 7): Buffer {
    const data = Buffer.alloc(size, fill);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return data;
}

let root: string;
let dir: string;

beforeEach(async () => {
    now = 1_000_000;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mt1962-store-"));
    dir = path.join(root, "favicons");
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

const Notion = "https://notion.so";
const Linear = "https://linear.app";
const Mail = "https://mail.google.com";

describe("the favicon store", () => {
    it("keeps an icon per origin and gives it back with its type", async () => {
        const store = new FaviconStore(dir, {}, clock);
        expect(await store.put(Notion, `${Notion}/icon.png`, "image/png", png(100))).toBe(true);
        const found = await store.getMany([Notion, Linear]);
        expect(Object.keys(found)).toEqual([Notion]);
        expect(found[Notion].mime).toBe("image/png");
        expect(found[Notion].data.length).toBe(100);
        expect(found[Notion].dark).toBeUndefined();
    });

    it("survives a restart: a new store reads what the last one kept", async () => {
        await new FaviconStore(dir, {}, clock).put(Notion, `${Notion}/i.png`, "image/png", png(50));
        const found = await new FaviconStore(dir, {}, clock).getMany([Notion]);
        expect(found[Notion].data.length).toBe(50);
    });

    it("refuses an image over the cap and an empty one, and keeps nothing for them", async () => {
        const store = new FaviconStore(dir, {}, clock);
        expect(await store.put(Notion, "a", "image/png", png(FaviconMaxBytes + 1))).toBe(false);
        expect(await store.put(Notion, "a", "image/png", Buffer.alloc(0))).toBe(false);
        expect(await store.origins()).toEqual([]);
        expect(await store.put(Notion, "a", "image/png", png(FaviconMaxBytes))).toBe(true);
    });

    it("tells a fresh icon at the same address from a changed or an old one", async () => {
        const store = new FaviconStore(dir, {}, clock);
        await store.put(Notion, "https://notion.so/a.png", "image/png", png(10));
        expect(await store.isFresh(Notion, "https://notion.so/a.png")).toBe(true);
        expect(await store.isFresh(Notion, "https://notion.so/b.png")).toBe(false);
        expect(await store.isFresh(Linear, "https://notion.so/a.png")).toBe(false);
        now += FaviconFreshMs + 1;
        expect(await store.isFresh(Notion, "https://notion.so/a.png")).toBe(false);
    });

    it("keeps the dark measure of an icon, and forgets it when the image changes", async () => {
        const store = new FaviconStore(dir, {}, clock);
        await store.put(Notion, "a", "image/png", png(10));
        expect(await store.setDark(Notion, true)).toBe(true);
        expect(await store.setDark(Notion, true)).toBe(false);
        expect((await store.getMany([Notion]))[Notion].dark).toBe(true);
        await store.put(Notion, "b", "image/png", png(12));
        expect((await store.getMany([Notion]))[Notion].dark).toBeUndefined();
        expect(await store.setDark(Linear, true)).toBe(false);
    });

    it("drops the origin used least recently once past the number it may keep", async () => {
        const store = new FaviconStore(dir, { maxOrigins: 2 }, clock);
        await store.put(Notion, "a", "image/png", png(10));
        now += 10;
        await store.put(Linear, "b", "image/png", png(10));
        now += 10;
        await store.getMany([Notion]);
        now += 10;
        await store.put(Mail, "c", "image/png", png(10));
        expect((await store.origins()).sort()).toEqual([Mail, Notion].sort());
        await expect(fs.stat(path.join(dir, faviconFileName(Linear)))).rejects.toThrow();
    });

    it("drops what has not been used for longer than the age it may keep", async () => {
        const store = new FaviconStore(dir, { maxAgeMs: 1000 }, clock);
        await store.put(Notion, "a", "image/png", png(10));
        now += 2000;
        await store.put(Linear, "b", "image/png", png(10));
        expect(await store.origins()).toEqual([Linear]);
    });

    it("clears everything, files and index, and starts again empty", async () => {
        const store = new FaviconStore(dir, {}, clock);
        await store.put(Notion, "a", "image/png", png(10));
        await store.put(Linear, "b", "image/png", png(10));
        expect(await store.clear()).toBe(2);
        expect(await store.getMany([Notion, Linear])).toEqual({});
        const files = (await fs.readdir(dir)).sort();
        expect(files).toEqual([FaviconIndexName]);
        expect(await new FaviconStore(dir, {}, clock).origins()).toEqual([]);
    });

    it("forgets an entry whose image is gone from the folder", async () => {
        const store = new FaviconStore(dir, {}, clock);
        await store.put(Notion, "a", "image/png", png(10));
        await fs.rm(path.join(dir, faviconFileName(Notion)));
        expect(await store.getMany([Notion])).toEqual({});
        expect(await store.origins()).toEqual([]);
    });

    it("starts empty when the index cannot be read, and runs concurrent writes one after the other", async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, FaviconIndexName), "not json");
        const store = new FaviconStore(dir, {}, clock);
        await Promise.all([
            store.put(Notion, "a", "image/png", png(10)),
            store.put(Linear, "b", "image/png", png(10)),
            store.put(Mail, "c", "image/png", png(10)),
        ]);
        expect((await store.origins()).sort()).toEqual([Linear, Mail, Notion].sort());
    });
});
