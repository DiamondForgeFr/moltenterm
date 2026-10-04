// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Whether the files a terminal mentions exist (FR-SHELL-017, DS-SHELL-018). xterm asks for the links of each line the
// mouse enters; the references of the same moment are sent to wavesrv in one stat per folder
// (RemoteFileMultiInfoCommand), and the answers are kept a while, so hovering back and forth costs nothing.

export type StatBatchFn = (conn: string, cwd: string, paths: string[]) => Promise<Record<string, FileInfo>>;

const BatchDelayMs = 25;
const FoundTtlMs = 60_000;
// A file an agent is about to write should become a link soon after.
const MissingTtlMs = 5_000;
const MaxEntries = 4000;

type Entry = { info: FileInfo; at: number };
type Pending = { conn: string; cwd: string; paths: Map<string, ((info: FileInfo) => void)[]> };

export function fileExists(info: FileInfo): boolean {
    return info != null && !info.notfound && !info.staterror;
}

export class FileStatCache {
    statFn: StatBatchFn;
    now: () => number;
    entries = new Map<string, Entry>();
    pending = new Map<string, Pending>();
    timer: ReturnType<typeof setTimeout> = null;

    constructor(statFn: StatBatchFn, now: () => number = Date.now) {
        this.statFn = statFn;
        this.now = now;
    }

    static key(conn: string, cwd: string, path: string): string {
        // An absolute path does not depend on the folder.
        return path.startsWith("/") ? `${conn}\n\n${path}` : `${conn}\n${cwd}\n${path}`;
    }

    cached(conn: string, cwd: string, path: string): FileInfo | undefined {
        const key = FileStatCache.key(conn, cwd, path);
        const entry = this.entries.get(key);
        if (entry == null) {
            return undefined;
        }
        const ttl = fileExists(entry.info) ? FoundTtlMs : MissingTtlMs;
        if (this.now() - entry.at > ttl) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.info;
    }

    // The file's info, or null when it does not exist or cannot be checked.
    stat(conn: string, cwd: string, path: string): Promise<FileInfo> {
        const hit = this.cached(conn, cwd, path);
        if (hit !== undefined) {
            return Promise.resolve(fileExists(hit) ? hit : null);
        }
        return new Promise((resolve) => {
            const batchKey = `${conn}\n${cwd}`;
            let batch = this.pending.get(batchKey);
            if (batch == null) {
                batch = { conn, cwd, paths: new Map() };
                this.pending.set(batchKey, batch);
            }
            const waiters = batch.paths.get(path) ?? [];
            waiters.push((info) => resolve(fileExists(info) ? info : null));
            batch.paths.set(path, waiters);
            if (this.timer == null) {
                this.timer = setTimeout(() => this.flush(), BatchDelayMs);
            }
        });
    }

    async flush(): Promise<void> {
        this.timer = null;
        const batches = Array.from(this.pending.values());
        this.pending.clear();
        await Promise.all(batches.map((b) => this.runBatch(b)));
    }

    async runBatch(batch: Pending): Promise<void> {
        const paths = Array.from(batch.paths.keys());
        let result: Record<string, FileInfo> = {};
        let failed = false;
        try {
            result = (await this.statFn(batch.conn, batch.cwd, paths)) ?? {};
        } catch (e) {
            // A connection going away: answer "no link" without caching, the next hover retries.
            console.log("file links: stat failed", e);
            failed = true;
        }
        for (const path of paths) {
            const info = result[path] ?? null;
            if (!failed) {
                this.store(FileStatCache.key(batch.conn, batch.cwd, path), info ?? { path, notfound: true });
            }
            for (const waiter of batch.paths.get(path)) {
                waiter(info);
            }
        }
    }

    store(key: string, info: FileInfo): void {
        if (this.entries.size >= MaxEntries) {
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
        this.entries.set(key, { info, at: this.now() });
    }
}
