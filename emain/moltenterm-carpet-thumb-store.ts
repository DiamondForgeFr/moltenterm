// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 carpet's thumbnails on disk (#1814, FR-SHELL-065 AC12, DS-SHELL-152): one small JPEG per carpet column,
// named after the column's first panel, and an index of what each was taken for. The tag is the column's validity key
// (its panels and their page addresses): a thumbnail is handed back only for the tag it was taken for, so a page that
// moved on never shows its old picture. The store caps its size (the entry used least recently goes first) and drops
// what has not been used for a long time. It lives in Electron main and knows nothing of Electron, so it is tested
// against a real folder.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const ThumbMaxBytes = 50 * 1024 * 1024;
export const ThumbMaxAgeMs = 60 * 24 * 60 * 60 * 1000;
export const ThumbMaxFileBytes = 1024 * 1024;
export const ThumbMaxTagChars = 4000;
export const ThumbIndexName = "index.json";
const ThumbFileExt = ".jpg";
const TempExt = ".tmp";
const KeyPattern = /^[A-Za-z0-9_-]{1,80}$/;

export function validThumbKey(key: unknown): key is string {
    return typeof key === "string" && KeyPattern.test(key);
}

export function validThumbTag(tag: unknown): tag is string {
    return typeof tag === "string" && tag.length <= ThumbMaxTagChars;
}

export function thumbFileName(key: string): string {
    return key + ThumbFileExt;
}

export type ThumbEntry = {
    tag: string;
    bytes: number;
    width: number;
    height: number;
    // When the picture was taken, and when it was last asked for or written (the least recently used goes first).
    at: number;
    used: number;
};

export type StoredThumb = { data: Buffer; width: number; height: number; at: number };

export type ThumbLimits = { maxBytes?: number; maxAgeMs?: number };

function isJpeg(data: Buffer): boolean {
    return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

function finite(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n);
}

function readEntry(raw: any): ThumbEntry {
    if (raw == null || !validThumbTag(raw.tag) || !finite(raw.bytes) || !finite(raw.at) || !finite(raw.used)) {
        return null;
    }
    return {
        tag: raw.tag,
        bytes: raw.bytes,
        width: finite(raw.width) ? raw.width : 0,
        height: finite(raw.height) ? raw.height : 0,
        at: raw.at,
        used: raw.used,
    };
}

export class CarpetThumbStore {
    dir: string;
    now: () => number;
    maxBytes: number;
    maxAgeMs: number;
    entries = new Map<string, ThumbEntry>();
    loading: Promise<void> = null;
    // Every operation waits for the one before it: the files and the index are touched one operation at a time.
    tail: Promise<unknown> = Promise.resolve();

    constructor(dir: string, now: () => number = () => Date.now(), limits: ThumbLimits = {}) {
        this.dir = dir;
        this.now = now;
        this.maxBytes = limits.maxBytes ?? ThumbMaxBytes;
        this.maxAgeMs = limits.maxAgeMs ?? ThumbMaxAgeMs;
    }

    totalBytes(): number {
        let total = 0;
        for (const e of this.entries.values()) {
            total += e.bytes;
        }
        return total;
    }

    // The thumbnails asked for that exist for exactly the tag asked.
    getMany(items: { key: string; tag: string }[]): Promise<Record<string, StoredThumb>> {
        return this.enqueue(async () => {
            const found: Record<string, StoredThumb> = {};
            let touched = false;
            for (const item of items) {
                const entry = validThumbKey(item?.key) ? this.entries.get(item.key) : null;
                if (entry == null || entry.tag !== item.tag) {
                    continue;
                }
                let data: Buffer;
                try {
                    data = await fs.readFile(this.filePath(item.key));
                } catch {
                    this.entries.delete(item.key);
                    touched = true;
                    continue;
                }
                entry.used = this.now();
                touched = true;
                found[item.key] = { data, width: entry.width, height: entry.height, at: entry.at };
            }
            if (touched) {
                await this.flush();
            }
            return found;
        });
    }

    put(key: string, tag: string, data: Buffer, width: number, height: number, at: number): Promise<boolean> {
        return this.enqueue(async () => {
            if (!validThumbKey(key) || !validThumbTag(tag) || !isJpeg(data) || data.length > ThumbMaxFileBytes) {
                return false;
            }
            const now = this.now();
            const file = this.filePath(key);
            const temp = file + TempExt;
            try {
                await fs.writeFile(temp, data);
                await fs.rename(temp, file);
            } catch (e) {
                await fs.rm(temp, { force: true }).catch(() => {});
                throw e;
            }
            this.entries.set(key, {
                tag,
                bytes: data.length,
                width: finite(width) ? Math.round(width) : 0,
                height: finite(height) ? Math.round(height) : 0,
                at: finite(at) ? Math.min(at, now) : now,
                used: now,
            });
            await this.evict(key);
            await this.flush();
            return true;
        });
    }

    // Closed panels: their files and entries go. Returns how many entries were removed.
    remove(keys: string[]): Promise<number> {
        return this.enqueue(async () => {
            let removed = 0;
            for (const key of keys) {
                if (!validThumbKey(key) || !this.entries.has(key)) {
                    continue;
                }
                this.entries.delete(key);
                await fs.rm(this.filePath(key), { force: true });
                removed++;
            }
            if (removed > 0) {
                await this.flush();
            }
            return removed;
        });
    }

    // Resolves when everything asked so far is done.
    idle(): Promise<void> {
        return this.enqueue(async () => {});
    }

    private filePath(key: string): string {
        return path.join(this.dir, thumbFileName(key));
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(() => this.ensureLoaded()).then(fn);
        this.tail = run.catch(() => {});
        return run;
    }

    private ensureLoaded(): Promise<void> {
        if (this.loading == null) {
            this.loading = this.load().catch((e) => {
                this.loading = null;
                throw e;
            });
        }
        return this.loading;
    }

    private async load(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        let changed = false;
        let raw: any = null;
        try {
            raw = JSON.parse(await fs.readFile(path.join(this.dir, ThumbIndexName), "utf8"));
        } catch {
            changed = true;
        }
        const now = this.now();
        const listed = raw?.version === 1 && raw.entries != null && typeof raw.entries === "object" ? raw.entries : {};
        for (const key of Object.keys(listed)) {
            const entry = validThumbKey(key) ? readEntry(listed[key]) : null;
            if (entry == null || now - entry.used > this.maxAgeMs) {
                changed = true;
                continue;
            }
            try {
                const stat = await fs.stat(this.filePath(key));
                entry.bytes = stat.size;
                this.entries.set(key, entry);
            } catch {
                changed = true;
            }
        }
        const wanted = new Set([...this.entries.keys()].map(thumbFileName));
        for (const name of await fs.readdir(this.dir)) {
            if ((name.endsWith(ThumbFileExt) || name.endsWith(TempExt)) && !wanted.has(name)) {
                await fs.rm(path.join(this.dir, name), { force: true });
            }
        }
        await this.evict(null);
        if (changed) {
            await this.flush();
        }
    }

    // The entries unused for too long, then the least recently used while the store is over its size. The entry just
    // written stays: it is the newest.
    private async evict(keep: string): Promise<void> {
        const now = this.now();
        for (const [key, entry] of [...this.entries]) {
            if (key !== keep && now - entry.used > this.maxAgeMs) {
                await this.drop(key);
            }
        }
        while (this.totalBytes() > this.maxBytes) {
            let oldest: string = null;
            for (const [key, entry] of this.entries) {
                if (key !== keep && (oldest == null || entry.used < this.entries.get(oldest).used)) {
                    oldest = key;
                }
            }
            if (oldest == null) {
                return;
            }
            await this.drop(oldest);
        }
    }

    private async drop(key: string): Promise<void> {
        this.entries.delete(key);
        await fs.rm(this.filePath(key), { force: true });
    }

    private async flush(): Promise<void> {
        const entries: Record<string, ThumbEntry> = {};
        for (const [key, entry] of this.entries) {
            entries[key] = entry;
        }
        const index = path.join(this.dir, ThumbIndexName);
        const temp = index + TempExt;
        await fs.writeFile(temp, JSON.stringify({ version: 1, entries }));
        await fs.rename(temp, index);
    }
}

// A picture of one flat colour (a page that has not painted, a blank window) identifies nothing: it is never kept. The
// bitmap is 4 bytes per pixel (BGRA or RGBA: the order does not matter here); a few stray pixels do not count.
export const FlatTolerance = 6;
export const FlatMaxDifferingPixels = 16;

export function isFlatBitmap(
    bitmap: Buffer,
    tolerance = FlatTolerance,
    maxDiffering = FlatMaxDifferingPixels
): boolean {
    if (bitmap == null || bitmap.length < 4) {
        return true;
    }
    const r = bitmap[0];
    const g = bitmap[1];
    const b = bitmap[2];
    let differing = 0;
    for (let i = 4; i + 2 < bitmap.length; i += 4) {
        if (
            Math.abs(bitmap[i] - r) > tolerance ||
            Math.abs(bitmap[i + 1] - g) > tolerance ||
            Math.abs(bitmap[i + 2] - b) > tolerance
        ) {
            differing++;
            if (differing > maxDiffering) {
                return false;
            }
        }
    }
    return true;
}
