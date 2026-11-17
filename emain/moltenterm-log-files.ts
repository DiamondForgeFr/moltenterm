// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The log files of the application (FR-PERF-016, #2335): waveapp.log is the current one, logs/waveapp.N.log the rotated
// ones. Electron main writes them all: its own lines, wavesrv's output it forwards and the windows' fe-log. The file
// rotates while the app runs, the set stays under a total cap, and Clear logs empties it without ever deleting the file
// the writer holds. The folder is the one the caller names, so a test works in a temporary one.

import * as fs from "fs";
import * as path from "path";

export const CurrentLogName = "waveapp.log";
export const LogsDirName = "logs";
export const LogRotateBytes = 10 * 1024 * 1024;
export const LogsKeptRotated = 5;
export const LogsTotalCapBytes = 200 * 1024 * 1024;
// Past this the notes say so: only a rotation that cannot move the file, or a flood faster than it, gets there.
export const LogsHighMarkBytes = 1_000_000_000;
// A stream that failed is opened again no sooner than this, so a full disk costs one attempt per period, not per line.
const ReopenAfterMs = 5000;

export type LogLimits = { rotateAt: number; keep: number; totalCap: number };

export const DefaultLogLimits: LogLimits = {
    rotateAt: LogRotateBytes,
    keep: LogsKeptRotated,
    totalCap: LogsTotalCapBytes,
};

export type RotatedLog = { name: string; num: number; size: number };

// What the logs weigh: the sizes only, never a path (the window asks for it and shows it).
export type LogsInfo = { total: number; current: number; rotated: number; files: number };

export type ClearResult = { ok: boolean; removed: number; freed: number; failed: number };

export function currentLogPath(dataDir: string): string {
    return path.join(dataDir, CurrentLogName);
}

export function logsDirPath(dataDir: string): string {
    return path.join(dataDir, LogsDirName);
}

export function rotatedLogNumber(name: string): number {
    const match = /^waveapp\.(\d+)\.log$/.exec(name);
    return match == null ? -1 : parseInt(match[1], 10);
}

async function sizeOf(file: string): Promise<number> {
    try {
        return (await fs.promises.stat(file)).size;
    } catch {
        return 0;
    }
}

async function isThere(file: string): Promise<boolean> {
    try {
        await fs.promises.access(file);
        return true;
    } catch {
        return false;
    }
}

// The rotated files, the oldest (lowest number) first.
export async function listRotatedLogs(dataDir: string): Promise<RotatedLog[]> {
    const dir = logsDirPath(dataDir);
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        return [];
    }
    const rtn: RotatedLog[] = [];
    for (const name of names) {
        const num = rotatedLogNumber(name);
        if (num < 0) {
            continue;
        }
        rtn.push({ name, num, size: await sizeOf(path.join(dir, name)) });
    }
    return rtn.sort((a, b) => a.num - b.num);
}

export async function readLogsInfo(dataDir: string): Promise<LogsInfo> {
    const current = await sizeOf(currentLogPath(dataDir));
    const rotated = await listRotatedLogs(dataDir);
    const rotatedBytes = rotated.reduce((sum, f) => sum + f.size, 0);
    // The current file counts as long as it is there, empty or not: "N files, the current one included".
    const present = (await isThere(currentLogPath(dataDir))) ? 1 : 0;
    return { total: current + rotatedBytes, current, rotated: rotatedBytes, files: rotated.length + present };
}

async function removeRotated(dataDir: string, file: RotatedLog): Promise<boolean> {
    try {
        await fs.promises.unlink(path.join(logsDirPath(dataDir), file.name));
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === "ENOENT";
    }
}

// The rotated files beyond the number kept go, then the oldest ones until the set, current file included, is under the
// total cap. The current file is never removed. It counts for what it can grow to before the next rotation, so the set
// stays under the cap while the file fills. Returns the names removed.
export async function pruneLogs(dataDir: string, limits: LogLimits, currentSize: number): Promise<string[]> {
    const rotated = await listRotatedLogs(dataDir);
    const removed: string[] = [];
    let total = Math.max(currentSize, limits.rotateAt) + rotated.reduce((sum, f) => sum + f.size, 0);
    let left = rotated.length;
    for (const file of rotated) {
        if (left <= limits.keep && total <= limits.totalCap) {
            break;
        }
        left--;
        total -= file.size;
        if (await removeRotated(dataDir, file)) {
            removed.push(file.name);
        }
    }
    return removed;
}

export type LogFileHooks = {
    // After a rotation, a pruning or a launch: what the logs now weigh.
    onMaintained?: (info: LogsInfo) => void;
    onError?: (message: string, error: unknown) => void;
    now?: () => number;
};

// The current log, appended to through one stream. Every write is kept, in order: while the file is being moved the
// lines wait in memory and go first to the new one.
export class RotatingLogFile {
    private stream: fs.WriteStream = null;
    private size = 0;
    private nextRotateAt: number;
    private held: string[] = null;
    private rotateQueued = false;
    private closed = false;
    private failedAt = 0;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly dataDir: string,
        private readonly limits: LogLimits = DefaultLogLimits,
        private hooks: LogFileHooks = {}
    ) {
        this.nextRotateAt = limits.rotateAt;
        fs.mkdirSync(logsDirPath(dataDir), { recursive: true });
        try {
            this.size = fs.statSync(currentLogPath(dataDir)).size;
        } catch {
            this.size = 0;
        }
        this.openStream();
        if (this.size >= this.nextRotateAt) {
            this.queueRotation();
        }
    }

    // The file exists before the rest of the app: whoever wants to hear of its maintenance says so once it is up.
    setHooks(hooks: LogFileHooks): void {
        this.hooks = hooks;
    }

    write(text: string): void {
        if (this.closed) {
            return;
        }
        if (this.held != null) {
            this.held.push(text);
            return;
        }
        this.append(text);
    }

    // The next maintenance, run after the writes already made and the work already asked.
    maintain(): Promise<LogsInfo> {
        return this.enqueue(() => this.doMaintain());
    }

    // The rotated files go and the current one is emptied in place: it stays open for the writer, which appends at its
    // new end.
    clear(): Promise<ClearResult> {
        return this.enqueue(() => this.doClear());
    }

    // Resolves once every line written so far is in the file and the asked work is done.
    async flush(): Promise<void> {
        let seen: Promise<unknown>;
        do {
            seen = this.chain;
            await seen;
        } while (seen !== this.chain);
        const stream = this.stream;
        if (stream == null || stream.destroyed) {
            return;
        }
        await new Promise<void>((resolve) => stream.write("", () => resolve()));
    }

    async close(): Promise<void> {
        await this.flush();
        this.closed = true;
        await this.endStream();
    }

    private append(text: string): void {
        const stream = this.openStream();
        if (stream == null) {
            return;
        }
        stream.write(text);
        this.size += Buffer.byteLength(text);
        if (this.size >= this.nextRotateAt && !this.rotateQueued) {
            this.queueRotation();
        }
    }

    private openStream(): fs.WriteStream {
        if (this.stream != null) {
            return this.stream;
        }
        const now = (this.hooks.now ?? Date.now)();
        if (this.failedAt > 0 && now - this.failedAt < ReopenAfterMs) {
            return null;
        }
        const stream = fs.createWriteStream(currentLogPath(this.dataDir), { flags: "a" });
        stream.on("error", (error) => {
            if (this.stream === stream) {
                this.stream = null;
            }
            this.failedAt = (this.hooks.now ?? Date.now)();
            this.hooks.onError?.("log file error", error);
        });
        this.stream = stream;
        this.failedAt = 0;
        return stream;
    }

    private endStream(): Promise<void> {
        const stream = this.stream;
        this.stream = null;
        if (stream == null || stream.destroyed) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            stream.once("close", () => resolve());
            stream.end();
        });
    }

    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const run = this.chain.then(op);
        this.chain = run.catch(() => undefined);
        return run;
    }

    private queueRotation(): void {
        this.rotateQueued = true;
        this.enqueue(() => this.doRotate()).catch((e) => this.hooks.onError?.("log rotation error", e));
    }

    private async doRotate(): Promise<void> {
        this.rotateQueued = false;
        if (this.size < this.nextRotateAt || this.closed) {
            return;
        }
        this.held = [];
        try {
            await this.moveCurrent();
            // What came in during the move goes first to the new file, a cap's worth to a file: a flood does not make
            // one rotated file of everything that arrived while the first was moved.
            while (this.fillFromHeld()) {
                await this.moveCurrent();
            }
        } catch (e) {
            // The file stays where it is and keeps growing: the next try is one rotation size further.
            this.nextRotateAt = this.size + this.limits.rotateAt;
            this.hooks.onError?.("log rotation failed", e);
        } finally {
            this.openStream();
            const rest = this.held;
            this.held = null;
            for (const text of rest) {
                this.append(text);
            }
            if (this.size >= this.nextRotateAt && !this.rotateQueued) {
                this.queueRotation();
            }
        }
        await this.doMaintain();
    }

    // The current file goes aside under the next number, and a new one opens at the same path.
    private async moveCurrent(): Promise<void> {
        await this.endStream();
        const rotated = await listRotatedLogs(this.dataDir);
        const num = (rotated.length > 0 ? rotated[rotated.length - 1].num : 0) + 1;
        await fs.promises.rename(
            currentLogPath(this.dataDir),
            path.join(logsDirPath(this.dataDir), `waveapp.${num}.log`)
        );
        this.size = 0;
        this.nextRotateAt = this.limits.rotateAt;
        this.openStream();
    }

    // Writes the held lines to the current file until it is full. True when lines are left, so the file must move again.
    private fillFromHeld(): boolean {
        const held = this.held;
        let next = 0;
        while (next < held.length && this.size < this.nextRotateAt) {
            const text = held[next++];
            const stream = this.openStream();
            if (stream == null) {
                continue;
            }
            stream.write(text);
            this.size += Buffer.byteLength(text);
        }
        this.held = held.slice(next);
        return this.held.length > 0;
    }

    private async doMaintain(): Promise<LogsInfo> {
        try {
            await pruneLogs(this.dataDir, this.limits, this.size);
        } catch (e) {
            this.hooks.onError?.("log pruning failed", e);
        }
        const info = await readLogsInfo(this.dataDir);
        this.hooks.onMaintained?.(info);
        return info;
    }

    private async doClear(): Promise<ClearResult> {
        const result: ClearResult = { ok: true, removed: 0, freed: 0, failed: 0 };
        for (const file of await listRotatedLogs(this.dataDir)) {
            if (await removeRotated(this.dataDir, file)) {
                result.removed++;
                result.freed += file.size;
            } else {
                result.failed++;
            }
        }
        const current = currentLogPath(this.dataDir);
        try {
            const before = await sizeOf(current);
            await fs.promises.truncate(current, 0);
            result.freed += before;
            this.size = 0;
            this.nextRotateAt = this.limits.rotateAt;
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
                result.failed++;
            }
        }
        result.ok = result.failed === 0;
        return result;
    }
}
