// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What tracks the downloads of the web pages (FR-MC-019 AC7-AC13, #1992). Electron main owns the DownloadItem objects,
// so everything that has to follow them lives here: the record of each download, pause, resume, cancel and retry, the
// bounded history on disk, the file's checks before it is opened, and what the windows are told. The Electron glue
// (moltenterm-downloads.ts) hands it the events and the real system calls; nothing here imports Electron, so the rules
// can be tested with a fake item.
//
// Coordination, not implementation: a download an agent's tab starts is held back by moltenterm-browseragent.ts
// (FR-BRW-010) before it gets here, and #1985 and #1982 will hold back more of them the same way (see
// moltenterm-download-hold.ts). A held download is never listed.

import * as path from "path";
import {
    clearedRecords,
    DownloadActRequest,
    DownloadActResult,
    DownloadOrigin,
    DownloadRecord,
    DownloadsSnapshot,
    hasExecuteBit,
    hostOf,
    interruptionReason,
    isActive,
    isExecutableName,
    pruneRecords,
    restoreRecords,
    safeFileName,
    uniqueFileName,
} from "../frontend/moltenterm-shell/downloads/downloads-model";

export type ItemLike = {
    getURL(): string;
    getURLChain(): string[];
    getFilename(): string;
    getMimeType(): string;
    getReceivedBytes(): number;
    getTotalBytes(): number;
    getSavePath(): string;
    setSavePath(path: string): void;
    setSaveDialogOptions(options: { defaultPath?: string }): void;
    pause(): void;
    resume(): void;
    cancel(): void;
    canResume(): boolean;
    isPaused(): boolean;
    getCurrentBytesPerSecond(): number;
    on(event: "updated" | "done", listener: (event: unknown, state: string) => void): unknown;
};

// Where a download came from: only what comes from a web page is listed (a page of a panel, a popup it opened, a Wave
// web block). startAgain starts an address again in the session the page lived in, which Retry uses.
export type DownloadSource = {
    web: boolean;
    origin: Partial<DownloadOrigin>;
    // The window that hosts the page, which tells the user about it when it ends.
    hostId: number;
    agent: string;
    startAgain: (url: string) => boolean;
};

export type DownloadEventLike = { defaultPrevented?: boolean };

export type ManagerDeps = {
    store: {
        load(): Promise<unknown>;
        save(items: DownloadRecord[]): Promise<void>;
        saveSync(items: DownloadRecord[]): void;
    };
    folder: () => string;
    askWhere: () => boolean;
    exists: (file: string) => boolean;
    // The permission bits of a file, or null when it is not there.
    statMode: (file: string) => Promise<number | null>;
    now: () => number;
    newId: () => string;
    platform: string;
    mark: (file: string, url: string, pageUrl: string) => Promise<unknown>;
    openPath: (file: string) => Promise<string>;
    showItem: (file: string) => void;
    broadcast: (snapshot: DownloadsSnapshot) => void;
    tell: (hostId: number, record: DownloadRecord, outcome: "done" | "failed") => void;
    startAgain: (url: string) => boolean;
    isHeld: (item: object) => boolean;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

// Bytes arrive many times a second: the windows hear them a few times a second, a state change at once.
export const BroadcastMs = 250;
export const SaveDelayMs = 500;
// A restarted download that never reaches the session (the site did not answer) is told as interrupted.
export const RestartWaitMs = 30000;

export class DownloadManager {
    private records: DownloadRecord[] = [];
    private live = new Map<string, ItemLike>();
    private hosts = new Map<string, number>();
    private starts = new Map<string, (url: string) => boolean>();
    private restarts = new Map<string, string>();
    private reserved = new Set<string>();
    private resumed = new Set<string>();
    private told = new Set<string>();
    private broadcastTimer: unknown = null;
    private saveTimer: unknown = null;

    constructor(private deps: ManagerDeps) {}

    // The history of the previous runs: what was running then is interrupted now.
    async restore(): Promise<void> {
        const now = this.deps.now();
        const raw = await this.deps.store.load();
        // A download that started before the file was read stays in the list.
        const started = new Set(this.records.map((r) => r.id));
        this.records = pruneRecords(
            [...this.records, ...restoreRecords(raw, now).filter((r) => !started.has(r.id))],
            now
        );
        if (raw != null) {
            this.scheduleSave();
        }
        this.broadcastNow();
    }

    snapshot(): DownloadsSnapshot {
        return {
            items: this.records.map((r) => ({ ...r })),
            folder: this.deps.folder(),
            askWhere: this.deps.askWhere(),
        };
    }

    activeCount(): number {
        return this.records.filter(isActive).length;
    }

    flushSync(): void {
        this.clearTimerOf("saveTimer");
        try {
            this.deps.store.saveSync(this.records);
        } catch (e) {
            console.log("downloads: saving the history failed", e instanceof Error ? e.message : String(e));
        }
    }

    // ---- a download starts ------------------------------------------------------------------------------------------

    // Called from the session's will-download, synchronously: the save path has to be set before the listener returns,
    // or the engine opens its own save dialog. Whether another listener holds the download back is only known once every
    // listener ran, so listing it waits for the next microtask.
    willDownload(event: DownloadEventLike, item: ItemLike, source: DownloadSource): void {
        const url = item.getURLChain()[0] || item.getURL();
        const restartId = this.restarts.get(url);
        if (restartId == null && !source.web) {
            return;
        }
        this.restarts.delete(url);
        const folder = this.deps.folder();
        let chosen = "";
        if (restartId != null || !this.deps.askWhere()) {
            const name = safeFileName(item.getFilename());
            const unique = uniqueFileName(
                name,
                (candidate) =>
                    this.reserved.has(path.join(folder, candidate)) || this.deps.exists(path.join(folder, candidate))
            );
            chosen = path.join(folder, unique);
            this.reserved.add(chosen);
            item.setSavePath(chosen);
        } else {
            item.setSaveDialogOptions({ defaultPath: path.join(folder, safeFileName(item.getFilename())) });
        }
        queueMicrotask(() => {
            if (event?.defaultPrevented === true || this.deps.isHeld(item)) {
                this.reserved.delete(chosen);
                return;
            }
            this.track(item, source, restartId, chosen, url);
        });
    }

    private find(id: string): DownloadRecord {
        return this.records.find((r) => r.id === id) ?? null;
    }

    private track(item: ItemLike, source: DownloadSource, restartId: string, chosen: string, url: string): void {
        const now = this.deps.now();
        let record = restartId == null ? null : this.find(restartId);
        const name = chosen === "" ? safeFileName(item.getFilename()) : path.basename(chosen);
        if (record != null) {
            Object.assign(record, {
                path: chosen,
                name,
                mime: item.getMimeType(),
                state: "progressing",
                received: 0,
                total: item.getTotalBytes(),
                bytesPerSecond: 0,
                startedAt: now,
                endedAt: 0,
                reason: "",
                missing: false,
                executable: false,
            });
        } else {
            record = {
                id: this.deps.newId(),
                url,
                host: hostOf(url),
                name,
                path: chosen,
                mime: item.getMimeType(),
                state: "progressing",
                received: 0,
                total: item.getTotalBytes(),
                bytesPerSecond: 0,
                startedAt: now,
                endedAt: 0,
                reason: "",
                executable: false,
                missing: false,
                agent: source.agent,
                workspaceId: source.origin.workspaceId ?? "",
                tabId: source.origin.tabId ?? "",
                blockId: source.origin.blockId ?? "",
                browserTabId: source.origin.browserTabId ?? "",
                pageUrl: source.origin.pageUrl ?? "",
                pageTitle: source.origin.pageTitle ?? "",
            };
            this.records.unshift(record);
            this.records = pruneRecords(this.records, now);
        }
        const id = record.id;
        this.live.set(id, item);
        this.hosts.set(id, source.hostId);
        this.starts.set(id, source.startAgain);
        this.resumed.delete(id);
        this.told.delete(id);
        item.on("updated", (_event, state) => this.updated(id, item, state));
        item.on("done", (_event, state) => this.done(id, item, state));
        this.touch(true);
    }

    // ---- what the engine reports ------------------------------------------------------------------------------------

    private sync(record: DownloadRecord, item: ItemLike): void {
        record.received = item.getReceivedBytes();
        record.total = item.getTotalBytes();
        const saved = item.getSavePath();
        if (saved !== "" && saved !== record.path) {
            record.path = saved;
            record.name = path.basename(saved);
        }
        record.mime = item.getMimeType() || record.mime;
    }

    private updated(id: string, item: ItemLike, state: string): void {
        const record = this.find(id);
        if (record == null || this.live.get(id) !== item) {
            return;
        }
        this.sync(record, item);
        if (state === "interrupted") {
            this.interrupt(record);
            return;
        }
        if (record.state === "paused" && item.isPaused()) {
            this.touch(false);
            return;
        }
        record.state = item.isPaused() ? "paused" : "progressing";
        record.bytesPerSecond = record.state === "progressing" ? item.getCurrentBytesPerSecond() : 0;
        this.touch(false);
    }

    private interrupt(record: DownloadRecord): void {
        const wasInterrupted = record.state === "interrupted";
        record.state = "interrupted";
        record.reason = interruptionReason(record.received, this.resumed.has(record.id));
        record.endedAt = record.endedAt || this.deps.now();
        record.bytesPerSecond = 0;
        this.touch(true);
        if (!wasInterrupted && !this.told.has(record.id)) {
            this.told.add(record.id);
            this.deps.tell(this.hosts.get(record.id) ?? 0, { ...record }, "failed");
        }
    }

    private done(id: string, item: ItemLike, state: string): void {
        const record = this.find(id);
        if (record == null || this.live.get(id) !== item) {
            return;
        }
        this.sync(record, item);
        if (state === "completed") {
            void this.completed(record, item);
            return;
        }
        if (state === "cancelled") {
            // The save dialog of "always ask where to save" was closed: nothing was ever started.
            if (record.path === "" && record.received === 0) {
                this.drop(record);
                return;
            }
            this.release(record);
            record.state = "cancelled";
            record.endedAt = this.deps.now();
            record.bytesPerSecond = 0;
            this.live.delete(id);
            this.touch(true);
            return;
        }
        this.interrupt(record);
    }

    private async completed(record: DownloadRecord, item: ItemLike): Promise<void> {
        const now = this.deps.now();
        this.release(record);
        this.live.delete(record.id);
        record.state = "completed";
        record.received = record.total > 0 ? record.total : record.received;
        record.total = record.total > 0 ? record.total : record.received;
        record.endedAt = now;
        record.bytesPerSecond = 0;
        record.reason = "";
        record.executable = isExecutableName(record.name);
        void item;
        const mode = await this.deps.statMode(record.path).catch(() => null);
        if (mode != null && this.deps.platform !== "win32" && hasExecuteBit(mode)) {
            record.executable = true;
        }
        await this.deps.mark(record.path, record.url, record.pageUrl).catch(() => null);
        this.touch(true);
        this.deps.tell(this.hosts.get(record.id) ?? 0, { ...record }, "done");
    }

    private release(record: DownloadRecord): void {
        this.reserved.delete(record.path);
    }

    private drop(record: DownloadRecord): void {
        this.release(record);
        this.live.delete(record.id);
        this.hosts.delete(record.id);
        this.starts.delete(record.id);
        this.records = this.records.filter((r) => r.id !== record.id);
        this.touch(true);
    }

    // ---- what the user asks -----------------------------------------------------------------------------------------

    async act(request: DownloadActRequest): Promise<DownloadActResult> {
        if (request.action === "openfolder") {
            const failed = await this.deps.openPath(this.deps.folder());
            return failed === "" ? { ok: true } : { ok: false, error: "failed" };
        }
        const record = typeof request.id === "string" ? this.find(request.id) : null;
        if (record == null) {
            return { ok: false, error: "noitem" };
        }
        switch (request.action) {
            case "pause":
                return this.pause(record);
            case "resume":
                return this.resume(record);
            case "cancel":
                return this.cancel(record);
            case "retry":
                return this.retry(record);
            case "open":
                return this.open(record, request.confirmed === true);
            case "reveal":
                return this.reveal(record);
            case "remove":
                if (isActive(record)) {
                    return { ok: false, error: "failed" };
                }
                this.drop(record);
                return { ok: true };
            default:
                return { ok: false, error: "failed" };
        }
    }

    private pause(record: DownloadRecord): DownloadActResult {
        const item = this.live.get(record.id);
        if (item == null || record.state !== "progressing") {
            return { ok: false, error: "failed" };
        }
        item.pause();
        record.state = "paused";
        record.bytesPerSecond = 0;
        this.touch(true);
        return { ok: true };
    }

    private resume(record: DownloadRecord): DownloadActResult {
        const item = this.live.get(record.id);
        if (item == null || record.state !== "paused" || !item.canResume()) {
            return { ok: false, error: "failed" };
        }
        this.resumed.add(record.id);
        item.resume();
        record.state = "progressing";
        this.touch(true);
        return { ok: true };
    }

    private cancel(record: DownloadRecord): DownloadActResult {
        const item = this.live.get(record.id);
        if (item == null || !isActive(record)) {
            return { ok: false, error: "failed" };
        }
        this.live.delete(record.id);
        item.cancel();
        this.release(record);
        record.state = "cancelled";
        record.endedAt = this.deps.now();
        record.bytesPerSecond = 0;
        this.touch(true);
        return { ok: true };
    }

    // Retry resumes where the download stopped when the engine can, and starts the address again otherwise: after a
    // restart there is no engine item left to resume.
    private retry(record: DownloadRecord): DownloadActResult {
        const failed = record.state === "interrupted" || record.state === "cancelled";
        const gone = record.state === "completed" && record.missing;
        if (!failed && !gone) {
            return { ok: false, error: "failed" };
        }
        const item = this.live.get(record.id);
        if (record.state === "interrupted" && item != null && item.canResume()) {
            this.resumed.add(record.id);
            this.told.delete(record.id);
            item.resume();
            record.state = "progressing";
            record.reason = "";
            record.endedAt = 0;
            this.touch(true);
            return { ok: true };
        }
        return this.startAgain(record);
    }

    private startAgain(record: DownloadRecord): DownloadActResult {
        const start = this.starts.get(record.id) ?? this.deps.startAgain;
        this.restarts.set(record.url, record.id);
        let started = false;
        try {
            started = start(record.url);
        } catch (e) {
            console.log("downloads: starting again failed", e instanceof Error ? e.message : String(e));
        }
        if (!started) {
            this.restarts.delete(record.url);
            return { ok: false, error: "failed" };
        }
        this.live.delete(record.id);
        this.resumed.delete(record.id);
        this.told.delete(record.id);
        record.state = "progressing";
        record.received = 0;
        record.total = 0;
        record.bytesPerSecond = 0;
        record.reason = "";
        record.endedAt = 0;
        record.missing = false;
        record.startedAt = this.deps.now();
        this.touch(true);
        const id = record.id;
        const url = record.url;
        this.deps.setTimer(() => {
            const waiting = this.restarts.get(url) === id;
            const current = this.find(id);
            if (!waiting || current == null || current.state !== "progressing" || this.live.has(id)) {
                return;
            }
            this.restarts.delete(url);
            current.state = "interrupted";
            current.reason = "server";
            current.endedAt = this.deps.now();
            this.touch(true);
            this.deps.tell(this.hosts.get(id) ?? 0, { ...current }, "failed");
        }, RestartWaitMs);
        return { ok: true };
    }

    // The file is checked here, in the main process, every time: a window cannot open what is gone, or a program it
    // was not allowed to.
    private async open(record: DownloadRecord, confirmed: boolean): Promise<DownloadActResult> {
        if (record.state !== "completed") {
            return { ok: false, error: "failed" };
        }
        const mode = await this.deps.statMode(record.path);
        if (mode == null) {
            record.missing = true;
            this.touch(true);
            return { ok: false, error: "missing" };
        }
        const program =
            record.executable ||
            isExecutableName(record.name) ||
            (this.deps.platform !== "win32" && hasExecuteBit(mode));
        if (program && !confirmed) {
            return { ok: false, error: "executable" };
        }
        const failed = await this.deps.openPath(record.path);
        return failed === "" ? { ok: true } : { ok: false, error: "failed" };
    }

    private async reveal(record: DownloadRecord): Promise<DownloadActResult> {
        if (record.state !== "completed") {
            return { ok: false, error: "failed" };
        }
        if ((await this.deps.statMode(record.path)) == null) {
            record.missing = true;
            this.touch(true);
            return { ok: false, error: "missing" };
        }
        this.deps.showItem(record.path);
        return { ok: true };
    }

    // Clearing the history removes the entries that are over and never a file or a running download.
    async clear(): Promise<number> {
        const { kept, removed } = clearedRecords(this.records);
        this.records = kept;
        this.touch(true);
        return removed;
    }

    // Which finished files are still there: when the section opens and the window gets the focus back, not in a loop.
    async check(): Promise<void> {
        const done = this.records.filter((r) => r.state === "completed");
        let changed = false;
        await Promise.all(
            done.map(async (record) => {
                const present = (await this.deps.statMode(record.path).catch(() => null)) != null;
                if (record.missing === present) {
                    record.missing = !present;
                    changed = true;
                }
            })
        );
        if (changed) {
            this.touch(true);
        }
    }

    // ---- telling the windows and the disk ---------------------------------------------------------------------------

    private touch(immediate: boolean): void {
        if (immediate) {
            this.broadcastNow();
        } else if (this.broadcastTimer == null) {
            this.broadcastTimer = this.deps.setTimer(() => {
                this.broadcastTimer = null;
                this.deps.broadcast(this.snapshot());
            }, BroadcastMs);
        }
        this.scheduleSave();
    }

    private broadcastNow(): void {
        this.clearTimerOf("broadcastTimer");
        this.deps.broadcast(this.snapshot());
    }

    private clearTimerOf(which: "broadcastTimer" | "saveTimer"): void {
        if (this[which] != null) {
            this.deps.clearTimer(this[which]);
            this[which] = null;
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer != null) {
            return;
        }
        this.saveTimer = this.deps.setTimer(() => {
            this.saveTimer = null;
            this.deps.store.save(this.records).catch((e) => {
                console.log("downloads: saving the history failed", e instanceof Error ? e.message : String(e));
            });
        }, SaveDelayMs);
    }
}
