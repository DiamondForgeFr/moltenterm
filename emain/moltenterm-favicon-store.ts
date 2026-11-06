// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sites' icons on disk (#1962, FR-SHELL-081 AC21-AC29, FR-BRW-019 AC11, DS-SHELL-126): one small image per origin, named
// after a hash of the origin, and an index of what each is. The icon is what the page itself declared, read through
// the page's own session (moltenterm-favicons.ts), so the sidebar, the menus and the lists draw it at startup, before
// any page has loaded. The store caps what it keeps (the size of an image, the number of origins, the time an origin
// goes unused) and clears all of it when the developer clears a web panel's cookies and storage. It lives in Electron
// main and knows nothing of Electron, so it is tested against a real folder.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export const FaviconMaxBytes = 64 * 1024;
export const FaviconMaxOrigins = 500;
export const FaviconMaxAgeMs = 90 * 24 * 60 * 60 * 1000;
// An origin whose icon was read less than this long ago is not read again for the same address.
export const FaviconFreshMs = 7 * 24 * 60 * 60 * 1000;
export const FaviconIndexName = "index.json";
const FileExt = ".img";
const TempExt = ".tmp";

export type FaviconEntry = {
    // The icon's address as the page declared it, to tell a changed icon from the one already kept.
    src: string;
    mime: string;
    bytes: number;
    // When it was read, and when it was last asked for or written (the least recently used goes first).
    at: number;
    used: number;
    // Measured once by the window that first drew it: true when the icon is too dark to read on the dark sidebar.
    dark?: boolean;
};

export type StoredFavicon = { data: Buffer; mime: string; dark?: boolean };

export type FaviconLimits = { maxOrigins?: number; maxAgeMs?: number };

export function faviconFileName(origin: string): string {
    return createHash("sha256").update(origin).digest("hex").slice(0, 32) + FileExt;
}

function validEntry(value: unknown): value is FaviconEntry {
    const e = value as Partial<FaviconEntry>;
    return (
        e != null &&
        typeof e.src === "string" &&
        typeof e.mime === "string" &&
        Number.isFinite(e.bytes) &&
        Number.isFinite(e.at) &&
        Number.isFinite(e.used)
    );
}

export class FaviconStore {
    private entries: Record<string, FaviconEntry> = null;
    private queue: Promise<unknown> = Promise.resolve();
    private maxOrigins: number;
    private maxAgeMs: number;

    constructor(
        private dir: string,
        limits: FaviconLimits = {},
        private now: () => number = Date.now
    ) {
        this.maxOrigins = limits.maxOrigins ?? FaviconMaxOrigins;
        this.maxAgeMs = limits.maxAgeMs ?? FaviconMaxAgeMs;
    }

    // Operations run one after the other: each starts from the index the one before it left.
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async load(): Promise<Record<string, FaviconEntry>> {
        if (this.entries != null) {
            return this.entries;
        }
        const loaded: Record<string, FaviconEntry> = {};
        try {
            const raw = JSON.parse(await fs.readFile(path.join(this.dir, FaviconIndexName), "utf8"));
            for (const [origin, entry] of Object.entries(raw?.entries ?? {})) {
                if (validEntry(entry)) {
                    loaded[origin] = entry;
                }
            }
        } catch {
            // No index yet, or one that cannot be read: the store starts empty and writes a new one.
        }
        this.entries = loaded;
        return loaded;
    }

    private async save(entries: Record<string, FaviconEntry>): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, FaviconIndexName);
        const temp = file + TempExt;
        await fs.writeFile(temp, JSON.stringify({ entries }));
        await fs.rename(temp, file);
    }

    private async drop(entries: Record<string, FaviconEntry>, origin: string): Promise<void> {
        delete entries[origin];
        await fs.rm(path.join(this.dir, faviconFileName(origin)), { force: true });
    }

    private async prune(entries: Record<string, FaviconEntry>): Promise<void> {
        const now = this.now();
        for (const [origin, entry] of Object.entries(entries)) {
            if (now - entry.used > this.maxAgeMs) {
                await this.drop(entries, origin);
            }
        }
        const byUse = Object.entries(entries).sort((a, b) => a[1].used - b[1].used);
        for (const [origin] of byUse.slice(0, Math.max(0, byUse.length - this.maxOrigins))) {
            await this.drop(entries, origin);
        }
    }

    // Whether this origin's icon, at this address, was read recently enough not to be read again.
    isFresh(origin: string, src: string): Promise<boolean> {
        return this.serial(async () => {
            const entry = (await this.load())[origin];
            return entry != null && entry.src === src && this.now() - entry.at < FaviconFreshMs;
        });
    }

    put(origin: string, src: string, mime: string, data: Buffer): Promise<boolean> {
        if (data.length === 0 || data.length > FaviconMaxBytes) {
            return Promise.resolve(false);
        }
        return this.serial(async () => {
            const entries = await this.load();
            await fs.mkdir(this.dir, { recursive: true });
            const file = path.join(this.dir, faviconFileName(origin));
            const temp = file + TempExt;
            await fs.writeFile(temp, data);
            await fs.rename(temp, file);
            const now = this.now();
            // A new image is measured again: the dark flag belongs to the image it was measured on.
            entries[origin] = { src, mime, bytes: data.length, at: now, used: now };
            await this.prune(entries);
            await this.save(entries);
            return entries[origin] != null;
        });
    }

    getMany(origins: string[]): Promise<Record<string, StoredFavicon>> {
        return this.serial(async () => {
            const entries = await this.load();
            const answer: Record<string, StoredFavicon> = {};
            const now = this.now();
            let touched = false;
            for (const origin of origins) {
                const entry = entries[origin];
                if (entry == null) {
                    continue;
                }
                try {
                    const data = await fs.readFile(path.join(this.dir, faviconFileName(origin)));
                    answer[origin] = { data, mime: entry.mime, dark: entry.dark };
                    entry.used = now;
                    touched = true;
                } catch {
                    // The image is gone from the folder: the entry goes with it.
                    await this.drop(entries, origin);
                    touched = true;
                }
            }
            if (touched) {
                await this.save(entries);
            }
            return answer;
        });
    }

    setDark(origin: string, dark: boolean): Promise<boolean> {
        return this.serial(async () => {
            const entries = await this.load();
            const entry = entries[origin];
            if (entry == null || entry.dark === dark) {
                return false;
            }
            entry.dark = dark;
            await this.save(entries);
            return true;
        });
    }

    // Everything the store keeps: what clearing a web panel's cookies and storage asks for.
    clear(): Promise<number> {
        return this.serial(async () => {
            const entries = await this.load();
            const count = Object.keys(entries).length;
            for (const origin of Object.keys(entries)) {
                await this.drop(entries, origin);
            }
            await this.save(entries);
            return count;
        });
    }

    origins(): Promise<string[]> {
        return this.serial(async () => Object.keys(await this.load()));
    }
}
