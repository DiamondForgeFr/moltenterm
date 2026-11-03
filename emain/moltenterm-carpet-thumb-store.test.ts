// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    CarpetThumbStore,
    FlatMaxDifferingPixels,
    isFlatBitmap,
    thumbFileName,
    ThumbIndexName,
    ThumbMaxFileBytes,
    validThumbKey,
} from "./moltenterm-carpet-thumb-store";

// The clock only moves when a test moves it: nothing here depends on how fast the machine is.
let now = 1_000_000;
const clock = () => now;

function jpeg(size: number, fill = 7): Buffer {
    const data = Buffer.alloc(size, fill);
    data[0] = 0xff;
    data[1] = 0xd8;
    data[2] = 0xff;
    return data;
}

let dir: string;
let root: string;

beforeEach(async () => {
    now = 1_000_000;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mt1814-store-"));
    dir = path.join(root, "carpet-thumbs");
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

async function names(): Promise<string[]> {
    return (await fs.readdir(dir)).sort();
}

describe("CarpetThumbStore validity (the thumbnail belongs to a panel and its page)", () => {
    it("hands a thumbnail back only for the tag it was taken for", async () => {
        const store = new CarpetThumbStore(dir, clock);
        await store.put("blockA", "blockA@https://a.dev/", jpeg(100), 640, 400, now);
        const same = await store.getMany([{ key: "blockA", tag: "blockA@https://a.dev/" }]);
        expect(same.blockA.data.length).toBe(100);
        expect(same.blockA).toMatchObject({ width: 640, height: 400, at: now });
        const other = await store.getMany([{ key: "blockA", tag: "blockA@https://a.dev/other" }]);
        expect(other).toEqual({});
    });

    it("keeps one thumbnail per panel: a new address replaces the old picture", async () => {
        const store = new CarpetThumbStore(dir, clock);
        await store.put("blockA", "tagA", jpeg(100, 1), 640, 400, now);
        await store.put("blockA", "tagB", jpeg(120, 2), 640, 400, now);
        expect(await store.getMany([{ key: "blockA", tag: "tagA" }])).toEqual({});
        const b = await store.getMany([{ key: "blockA", tag: "tagB" }]);
        expect(b.blockA.data[10]).toBe(2);
        expect(await names()).toEqual([thumbFileName("blockA"), ThumbIndexName]);
    });

    it("survives a restart: a new store on the same folder still has what was kept", async () => {
        const first = new CarpetThumbStore(dir, clock);
        await first.put("blockA", "tagA", jpeg(100), 640, 400, now);
        await first.put("blockB", "tagB", jpeg(200), 640, 300, now);
        await first.idle();

        const second = new CarpetThumbStore(dir, clock);
        const found = await second.getMany([
            { key: "blockA", tag: "tagA" },
            { key: "blockB", tag: "tagB" },
            { key: "blockC", tag: "tagC" },
        ]);
        expect(Object.keys(found).sort()).toEqual(["blockA", "blockB"]);
        expect(found.blockB.data.length).toBe(200);
    });

    it("never takes a picture that is not a small JPEG", async () => {
        const store = new CarpetThumbStore(dir, clock);
        expect(await store.put("blockA", "t", Buffer.from("not a picture"), 1, 1, now)).toBe(false);
        expect(await store.put("blockA", "t", jpeg(ThumbMaxFileBytes + 1), 1, 1, now)).toBe(false);
        expect(await store.put("blockA", "x".repeat(5000), jpeg(10), 1, 1, now)).toBe(false);
        expect(await store.getMany([{ key: "blockA", tag: "t" }])).toEqual({});
    });
});

describe("CarpetThumbStore removal (a closed panel's thumbnail goes)", () => {
    it("removes the file and the entry, once", async () => {
        const store = new CarpetThumbStore(dir, clock);
        await store.put("blockA", "tagA", jpeg(100), 640, 400, now);
        await store.put("blockB", "tagB", jpeg(100), 640, 400, now);
        expect(await store.remove(["blockA", "unknown"])).toBe(1);
        expect(await store.remove(["blockA"])).toBe(0);
        expect(await names()).toEqual([thumbFileName("blockB"), ThumbIndexName]);

        const again = new CarpetThumbStore(dir, clock);
        expect(await again.getMany([{ key: "blockA", tag: "tagA" }])).toEqual({});
        expect(Object.keys(await again.getMany([{ key: "blockB", tag: "tagB" }]))).toEqual(["blockB"]);
    });

    it("ignores a key that could name a file outside its folder", async () => {
        const outside = path.join(root, "secret.jpg");
        await fs.writeFile(outside, jpeg(10));
        const store = new CarpetThumbStore(dir, clock);
        await store.put("blockA", "tagA", jpeg(100), 1, 1, now);
        expect(validThumbKey("../secret")).toBe(false);
        expect(validThumbKey("a/b")).toBe(false);
        expect(await store.put("../secret", "t", jpeg(10), 1, 1, now)).toBe(false);
        expect(await store.remove(["../secret", "..", "/etc/passwd"])).toBe(0);
        await expect(fs.stat(outside)).resolves.toBeTruthy();
        expect(await store.getMany([{ key: "../secret", tag: "t" }])).toEqual({});
    });
});

describe("CarpetThumbStore size cap (the least recently used goes first)", () => {
    it("evicts the entry used least recently, not the oldest written", async () => {
        const store = new CarpetThumbStore(dir, clock, { maxBytes: 350 });
        await store.put("blockA", "t", jpeg(100), 1, 1, now);
        now += 1000;
        await store.put("blockB", "t", jpeg(100), 1, 1, now);
        now += 1000;
        await store.put("blockC", "t", jpeg(100), 1, 1, now);
        now += 1000;
        await store.getMany([{ key: "blockA", tag: "t" }]);
        now += 1000;
        await store.put("blockD", "t", jpeg(100), 1, 1, now);

        expect(store.totalBytes()).toBeLessThanOrEqual(350);
        const left = await store.getMany(["blockA", "blockB", "blockC", "blockD"].map((key) => ({ key, tag: "t" })));
        expect(Object.keys(left).sort()).toEqual(["blockA", "blockC", "blockD"]);
        expect(await names()).toEqual([ThumbIndexName, ...["blockA", "blockC", "blockD"].map(thumbFileName)].sort());
    });

    it("keeps the entry just written even when it alone is over the cap", async () => {
        const store = new CarpetThumbStore(dir, clock, { maxBytes: 50 });
        await store.put("blockA", "t", jpeg(100), 1, 1, now);
        expect(Object.keys(await store.getMany([{ key: "blockA", tag: "t" }]))).toEqual(["blockA"]);
    });

    it("drops what has not been used for too long, when the store opens", async () => {
        const day = 24 * 60 * 60 * 1000;
        const first = new CarpetThumbStore(dir, clock, { maxAgeMs: 10 * day });
        await first.put("blockA", "t", jpeg(100), 1, 1, now);
        now += 6 * day;
        await first.put("blockB", "t", jpeg(100), 1, 1, now);
        await first.idle();
        now += 6 * day;

        const second = new CarpetThumbStore(dir, clock, { maxAgeMs: 10 * day });
        const found = await second.getMany([
            { key: "blockA", tag: "t" },
            { key: "blockB", tag: "t" },
        ]);
        expect(Object.keys(found)).toEqual(["blockB"]);
        expect(await names()).toEqual([thumbFileName("blockB"), ThumbIndexName]);
    });
});

describe("CarpetThumbStore on a damaged folder", () => {
    it("starts empty on a corrupt index and sweeps the files nothing refers to", async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, ThumbIndexName), "{ this is not json");
        await fs.writeFile(path.join(dir, thumbFileName("orphan")), jpeg(100));
        await fs.writeFile(path.join(dir, thumbFileName("half") + ".tmp"), jpeg(100));
        await fs.writeFile(path.join(dir, "notes.txt"), "mine");

        const store = new CarpetThumbStore(dir, clock);
        expect(await store.getMany([{ key: "orphan", tag: "t" }])).toEqual({});
        expect(await names()).toEqual([ThumbIndexName, "notes.txt"]);
        await store.put("blockA", "t", jpeg(10), 1, 1, now);
        expect(Object.keys(await store.getMany([{ key: "blockA", tag: "t" }]))).toEqual(["blockA"]);
    });

    it("forgets an entry whose file went missing", async () => {
        const first = new CarpetThumbStore(dir, clock);
        await first.put("blockA", "t", jpeg(100), 1, 1, now);
        await first.put("blockB", "t", jpeg(100), 1, 1, now);
        await first.idle();
        await fs.rm(path.join(dir, thumbFileName("blockA")));

        const second = new CarpetThumbStore(dir, clock);
        const found = await second.getMany([
            { key: "blockA", tag: "t" },
            { key: "blockB", tag: "t" },
        ]);
        expect(Object.keys(found)).toEqual(["blockB"]);
    });

    it("forgets an entry whose file vanishes while the store runs", async () => {
        const store = new CarpetThumbStore(dir, clock);
        await store.put("blockA", "t", jpeg(100), 1, 1, now);
        await fs.rm(path.join(dir, thumbFileName("blockA")));
        expect(await store.getMany([{ key: "blockA", tag: "t" }])).toEqual({});
        expect(store.totalBytes()).toBe(0);
    });
});

describe("CarpetThumbStore concurrency", () => {
    it("takes many writes at once without losing one or tearing the index", async () => {
        const store = new CarpetThumbStore(dir, clock);
        const keys = Array.from({ length: 30 }, (_, i) => `block${i}`);
        await Promise.all(keys.map((key, i) => store.put(key, `tag${i}`, jpeg(50 + i), 10, 10, now)));
        await Promise.all(keys.filter((_, i) => i % 3 === 0).map((key) => store.remove([key])));
        await store.idle();

        const again = new CarpetThumbStore(dir, clock);
        const found = await again.getMany(keys.map((key, i) => ({ key, tag: `tag${i}` })));
        expect(Object.keys(found).sort()).toEqual(keys.filter((_, i) => i % 3 !== 0).sort());
        expect((await names()).length).toBe(1 + Object.keys(found).length);
    });
});

describe("isFlatBitmap (a frame of one flat colour is never kept)", () => {
    function bitmap(pixels: number, color: [number, number, number, number]): Buffer {
        const data = Buffer.alloc(pixels * 4);
        for (let i = 0; i < pixels; i++) {
            data.set(color, i * 4);
        }
        return data;
    }

    it("sees a blank page and an empty capture as flat", () => {
        expect(isFlatBitmap(bitmap(10_000, [255, 255, 255, 255]))).toBe(true);
        expect(isFlatBitmap(bitmap(10_000, [20, 20, 20, 255]))).toBe(true);
        expect(isFlatBitmap(Buffer.alloc(0))).toBe(true);
        expect(isFlatBitmap(null)).toBe(true);
    });

    it("ignores a few stray pixels and a slight gradient", () => {
        const data = bitmap(10_000, [255, 255, 255, 255]);
        for (let i = 0; i < FlatMaxDifferingPixels; i++) {
            data.set([0, 0, 0, 255], (100 + i) * 4);
        }
        expect(isFlatBitmap(data)).toBe(true);
        const gradient = bitmap(10_000, [200, 200, 200, 255]);
        for (let i = 0; i < 10_000; i++) {
            gradient[i * 4] = 200 + (i % 4);
        }
        expect(isFlatBitmap(gradient)).toBe(true);
    });

    it("sees a page with content, however pale, as a picture", () => {
        const data = bitmap(10_000, [255, 255, 255, 255]);
        for (let i = 0; i <= FlatMaxDifferingPixels; i++) {
            data.set([0, 0, 0, 255], (100 + i) * 4);
        }
        expect(isFlatBitmap(data)).toBe(false);
        const heading = bitmap(10_000, [250, 250, 250, 255]);
        for (let i = 0; i < 400; i++) {
            heading.set([30, 30, 30, 255], (2000 + i) * 4);
        }
        expect(isFlatBitmap(heading)).toBe(false);
    });
});
