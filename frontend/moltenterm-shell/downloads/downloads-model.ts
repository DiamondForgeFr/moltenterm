// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The downloads of the web pages (FR-MC-019 AC7-AC13, #1992): what Electron main tracks (emain/moltenterm-downloads.ts)
// and the windows draw in the notification center. This file is the pure part both sides share: the record, its
// states, how the history is bounded, how a file is told to be a program, and the rules that decide what a row says
// and offers. #1985 (downloads from tabs an agent opened) and #1982 (reputation, the warning at download time) plug
// into the same record later: this ticket implements neither.

// 200 entries or 90 days, whichever comes first (Q5); what is in progress is never pruned.
export const MaxDownloadEntries = 200;
export const MaxDownloadAgeMs = 90 * 24 * 60 * 60 * 1000;

export type DownloadState = "progressing" | "paused" | "completed" | "interrupted" | "cancelled";

// Electron does not say why a download stopped: what can be told is told from what was received.
//   connection  bytes arrived, then the connection stopped
//   server      nothing arrived: the site refused the file or does not have it
//   appclosed   MoltenTerm was closed while it ran
//   noresume    the site does not let a stopped download go on from where it stopped
export type DownloadReason = "connection" | "server" | "appclosed" | "noresume";

// Where the download started, so a row can lead back (#1992). The page's own state is not kept here: whether the
// panel, its view or its workspace still exist is read when the row is drawn (downloads-origin.ts).
export type DownloadOrigin = {
    workspaceId: string;
    tabId: string;
    blockId: string;
    browserTabId: string;
    pageUrl: string;
    pageTitle: string;
};

export type DownloadRecord = DownloadOrigin & {
    id: string;
    // The address that was asked for, which Copy link and Retry use.
    url: string;
    host: string;
    name: string;
    // Absolute path of the saved file, empty until the engine knows it.
    path: string;
    mime: string;
    state: DownloadState;
    received: number;
    // 0 when the site gives no size.
    total: number;
    bytesPerSecond: number;
    startedAt: number;
    // 0 while it runs.
    endedAt: number;
    reason: DownloadReason | "";
    // A program, installer, script, shortcut or disk image, or a file with the execute permission: Open asks first.
    executable: boolean;
    // The last check found the finished file gone; never persisted as a promise.
    missing: boolean;
    // The name of the agent that started it, when one did (FR-BRW-010).
    agent: string;
    // web: a page's download. files: the Files panel's Download of a file on a connection (#2163), whose address is
    // MoltenTerm's own local stream and whose host is the connection's name.
    source?: DownloadRecordSource;
};

export type DownloadRecordSource = "web" | "files";

export type DownloadsSnapshot = { items: DownloadRecord[]; folder: string; askWhere: boolean };

export type DownloadAction = "pause" | "resume" | "cancel" | "retry" | "open" | "reveal" | "remove" | "openfolder";

export const DownloadActions: DownloadAction[] = [
    "pause",
    "resume",
    "cancel",
    "retry",
    "open",
    "reveal",
    "remove",
    "openfolder",
];

export type DownloadActRequest = { id?: string; action: DownloadAction; confirmed?: boolean };
export type DownloadActResult = {
    ok: boolean;
    // A code the window words, never raw text: missing | executable | noitem | failed
    error?: string;
};

export function isActiveState(state: DownloadState): boolean {
    return state === "progressing" || state === "paused";
}

export function isActive(record: Pick<DownloadRecord, "state">): boolean {
    return isActiveState(record.state);
}

// ---- what is a program -------------------------------------------------------------------------------------------

// Programs and installers, scripts, shortcuts and disk images (Q4): archives and documents are only read.
const ExecutableExtensions = new Set([
    // programs and installers
    "exe",
    "msi",
    "app",
    "pkg",
    "dmg",
    "deb",
    "rpm",
    "appimage",
    "run",
    "jar",
    "apk",
    // scripts
    "sh",
    "bash",
    "zsh",
    "command",
    "bat",
    "cmd",
    "ps1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "py",
    "pl",
    "rb",
    // shortcuts and launchers
    "lnk",
    "desktop",
    "terminal",
    "workflow",
    "scr",
    "com",
    "url",
    "webloc",
    // disk images
    "iso",
    "img",
    "vhd",
    "vhdx",
]);

// The last extension of the final name, ignoring the trailing dots and spaces some systems drop ("setup.exe. ").
export function extensionOf(name: string): string {
    const trimmed = String(name ?? "")
        .replace(/[\s.]+$/, "")
        .toLowerCase();
    const dot = trimmed.lastIndexOf(".");
    if (dot <= 0 || dot === trimmed.length - 1) {
        return "";
    }
    return trimmed.slice(dot + 1);
}

export function isExecutableName(name: string): boolean {
    return ExecutableExtensions.has(extensionOf(name));
}

// A permission bit for the owner, group or others (never true on a system without them, where the caller passes 0).
export function hasExecuteBit(mode: number): boolean {
    return Number.isInteger(mode) && (mode & 0o111) !== 0;
}

// ---- history -----------------------------------------------------------------------------------------------------

// The list the history keeps: what runs stays, the rest is cut by age and then by count, the newest first.
export function pruneRecords(
    items: DownloadRecord[],
    now: number,
    maxCount: number = MaxDownloadEntries,
    maxAgeMs: number = MaxDownloadAgeMs
): DownloadRecord[] {
    const active = items.filter(isActive);
    const closed = items
        .filter((r) => !isActive(r))
        .filter((r) => now - (r.endedAt || r.startedAt) <= maxAgeMs)
        .sort((a, b) => b.startedAt - a.startedAt);
    const room = Math.max(0, maxCount - active.length);
    return [...active, ...closed.slice(0, room)].sort((a, b) => b.startedAt - a.startedAt);
}

function str(value: unknown, max = 4096): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

const States = new Set<string>(["progressing", "paused", "completed", "interrupted", "cancelled"]);
const Reasons = new Set<string>(["connection", "server", "appclosed", "noresume"]);

// One record read back from the history file: anything unreadable is dropped, any missing field is the empty value.
export function parseRecord(value: unknown): DownloadRecord {
    const raw = value as Record<string, unknown>;
    if (raw == null || typeof raw !== "object" || typeof raw.id !== "string" || raw.id === "") {
        return null;
    }
    const state = States.has(raw.state as string) ? (raw.state as DownloadState) : null;
    if (state == null) {
        return null;
    }
    return {
        id: str(raw.id, 100),
        url: str(raw.url),
        host: str(raw.host, 253),
        name: str(raw.name, 255),
        path: str(raw.path),
        mime: str(raw.mime, 200),
        state,
        received: num(raw.received),
        total: num(raw.total),
        bytesPerSecond: 0,
        startedAt: num(raw.startedAt),
        endedAt: num(raw.endedAt),
        reason: Reasons.has(raw.reason as string) ? (raw.reason as DownloadReason) : "",
        executable: raw.executable === true,
        missing: false,
        agent: str(raw.agent, 100),
        source: raw.source === "files" ? "files" : "web",
        workspaceId: str(raw.workspaceId, 200),
        tabId: str(raw.tabId, 200),
        blockId: str(raw.blockId, 200),
        browserTabId: str(raw.browserTabId, 200),
        pageUrl: str(raw.pageUrl),
        pageTitle: str(raw.pageTitle, 500),
    };
}

// The history file's content as the records it holds. What was running when MoltenTerm quit is told as interrupted
// (AC11): it cannot still be running, and its partial file is not ours to resume.
export function restoreRecords(raw: unknown, now: number): DownloadRecord[] {
    const list = (raw as { items?: unknown })?.items;
    if (!Array.isArray(list)) {
        return [];
    }
    const records = list.map(parseRecord).filter((r): r is DownloadRecord => r != null);
    const restored = records.map((r) =>
        isActive(r)
            ? { ...r, state: "interrupted" as DownloadState, reason: "appclosed" as DownloadReason, endedAt: now }
            : r
    );
    return pruneRecords(restored, now);
}

// ---- what a row says ---------------------------------------------------------------------------------------------

// The percentage of a download whose size is known, or null (no percentage is invented).
export function percentOf(record: Pick<DownloadRecord, "received" | "total">): number {
    if (!(record.total > 0)) {
        return null;
    }
    return Math.max(0, Math.min(100, Math.floor((record.received / record.total) * 100)));
}

export function secondsLeft(record: Pick<DownloadRecord, "received" | "total" | "bytesPerSecond" | "state">): number {
    if (record.state !== "progressing" || !(record.total > record.received) || !(record.bytesPerSecond > 0)) {
        return null;
    }
    return Math.ceil((record.total - record.received) / record.bytesPerSecond);
}

// What a ring reads of a running download or tracked transfer (#2163).
export type RingProgress = Pick<DownloadRecord, "state" | "received" | "total">;

// The ring of the bell and the pill: the mean of what is measured, null when nothing running knows its size.
export function overallDownloadProgress(items: RingProgress[]): number {
    const measured = items.filter((r) => r.state === "progressing" && r.total > 0);
    if (measured.length === 0) {
        return null;
    }
    return measured.reduce((sum, r) => sum + Math.min(1, r.received / r.total), 0) / measured.length;
}

export function runningDownloads(items: DownloadRecord[]): DownloadRecord[] {
    return items.filter(isActive);
}

// The ring of Brokk's face (FR-BOSS-009, AC34, #2083) and of the rail: the overall progress of the running downloads,
// -1 while none of them knows its size, null while none runs. A failed or finished download is not running, so it shows none.
export function downloadRingOf(running: RingProgress[]): number {
    if (running.length === 0) {
        return null;
    }
    return overallDownloadProgress(running) ?? -1;
}

// What stopped a download, from what was received. A cancel by the user is not an interruption.
export function interruptionReason(received: number, wasResumed: boolean): DownloadReason {
    if (wasResumed) {
        return "noresume";
    }
    return received > 0 ? "connection" : "server";
}

export type DownloadDay = { key: string; kind: "today" | "yesterday" | "date"; time: number; items: DownloadRecord[] };
export type DownloadGroups = { running: DownloadRecord[]; days: DownloadDay[] };

function startOfDay(time: number): number {
    const d = new Date(time);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// In progress first, then the closed ones by the day they started, the newest first.
export function groupDownloads(items: DownloadRecord[], now: number): DownloadGroups {
    const sorted = [...items].sort((a, b) => b.startedAt - a.startedAt);
    const running = sorted.filter(isActive);
    const today = startOfDay(now);
    const yesterday = startOfDay(today - 12 * 60 * 60 * 1000);
    const days: DownloadDay[] = [];
    for (const record of sorted.filter((r) => !isActive(r))) {
        const day = startOfDay(record.startedAt);
        let group = days.find((d) => d.time === day);
        if (group == null) {
            group = {
                key: String(day),
                kind: day === today ? "today" : day === yesterday ? "yesterday" : "date",
                time: day,
                items: [],
            };
            days.push(group);
        }
        group.items.push(record);
    }
    return { running, days };
}

// What a row offers, never an action that cannot work: a file that is gone offers Download again instead of Open.
export type RowActions = {
    pause: boolean;
    resume: boolean;
    cancel: boolean;
    retry: boolean;
    open: boolean;
    reveal: boolean;
    redownload: boolean;
    copyLink: boolean;
    remove: boolean;
};

export function rowActions(record: DownloadRecord): RowActions {
    const done = record.state === "completed";
    const present = done && !record.missing;
    const failed = record.state === "interrupted" || record.state === "cancelled";
    return {
        pause: record.state === "progressing",
        resume: record.state === "paused",
        cancel: isActive(record),
        retry: failed,
        open: present,
        reveal: present,
        redownload: done && record.missing,
        // The Files panel's address is MoltenTerm's own local stream: nothing another app could open.
        copyLink: record.url !== "" && record.source !== "files",
        remove: !isActive(record),
    };
}

// ---- the whole list ----------------------------------------------------------------------------------------------

// Clearing the history: what is over goes, what runs stays, and no file is touched.
export function clearedRecords(items: DownloadRecord[]): { kept: DownloadRecord[]; removed: number } {
    const kept = items.filter(isActive);
    return { kept, removed: items.length - kept.length };
}

// A file name that is safe to create in a folder: no separators or control characters, no leading dots, no longer than
// the file systems allow; "download" when nothing is left.
export function safeFileName(name: string): string {
    let clean = String(name ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
        .replace(/^[.\s]+/, "")
        .replace(/[.\s]+$/, "");
    if (clean.length > 200) {
        const ext = extensionOf(clean);
        clean = ext === "" ? clean.slice(0, 200) : `${clean.slice(0, 200 - ext.length - 1)}.${ext}`;
    }
    return clean === "" ? "download" : clean;
}

// "report.pdf" taken: "report (1).pdf", then "report (2).pdf". `taken` says whether a name is already in use.
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
    if (!taken(name)) {
        return name;
    }
    const ext = extensionOf(name);
    const stem = ext === "" ? name : name.slice(0, name.length - ext.length - 1);
    for (let i = 1; i < 10000; i++) {
        const candidate = ext === "" ? `${stem} (${i})` : `${stem} (${i}).${ext}`;
        if (!taken(candidate)) {
            return candidate;
        }
    }
    return `${stem} (${Date.now()})${ext === "" ? "" : `.${ext}`}`;
}

// The connection of a Files panel address ("wsh://<connection>/<path>"), which its row shows in place of a site (#2163).
export function connectionOfRemoteUri(uri: string): string {
    const m = /^wsh:\/\/([^/]*)/.exec(String(uri ?? ""));
    return m == null ? "" : m[1].slice(0, 253);
}

// The site a row shows: the host of the address, without "www.".
export function hostOf(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return "";
        }
        return parsed.host.replace(/^www\./, "");
    } catch {
        return "";
    }
}

// The measured progress of each download that runs, for the bell's ring to average with the other running work.
export function downloadProgressValues(items: DownloadRecord[]): number[] {
    return items.filter((r) => r.state === "progressing" && r.total > 0).map((r) => Math.min(1, r.received / r.total));
}
