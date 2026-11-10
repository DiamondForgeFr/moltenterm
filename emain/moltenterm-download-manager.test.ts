// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from "path";
import { describe, expect, it } from "vitest";
import type { DownloadRecord } from "../frontend/moltenterm-shell/downloads/downloads-model";
import {
    BroadcastMs,
    DownloadManager,
    DownloadSource,
    ItemLike,
    ManagerDeps,
    RestartWaitMs,
    SaveDelayMs,
} from "./moltenterm-download-manager";

const Folder = "/dl";

class FakeItem implements ItemLike {
    listeners: Record<string, ((e: unknown, state: string) => void)[]> = { updated: [], done: [] };
    received = 0;
    total = 1000;
    savePath = "";
    dialog: { defaultPath?: string } = null;
    paused = false;
    resumable = true;
    speed = 0;
    calls: string[] = [];
    constructor(
        public url = "https://example.com/files/report.pdf",
        public filename = "report.pdf"
    ) {}
    getURL() {
        return this.url;
    }
    getURLChain() {
        return [this.url];
    }
    getFilename() {
        return this.filename;
    }
    getMimeType() {
        return "application/octet-stream";
    }
    getReceivedBytes() {
        return this.received;
    }
    getTotalBytes() {
        return this.total;
    }
    getSavePath() {
        return this.savePath;
    }
    setSavePath(p: string) {
        this.savePath = p;
    }
    setSaveDialogOptions(o: { defaultPath?: string }) {
        this.dialog = o;
    }
    pause() {
        this.paused = true;
        this.calls.push("pause");
    }
    resume() {
        this.paused = false;
        this.calls.push("resume");
    }
    cancel() {
        this.calls.push("cancel");
    }
    canResume() {
        return this.resumable;
    }
    isPaused() {
        return this.paused;
    }
    getCurrentBytesPerSecond() {
        return this.speed;
    }
    on(event: "updated" | "done", listener: (e: unknown, state: string) => void) {
        this.listeners[event].push(listener);
    }
    emit(event: "updated" | "done", state: string) {
        for (const listener of this.listeners[event]) {
            listener({}, state);
        }
    }
}

type Timer = { fn: () => void; ms: number; live: boolean };

function makeHarness(over: Partial<ManagerDeps> = {}, saved: unknown = null) {
    const files = new Map<string, number>();
    const timers: Timer[] = [];
    const log = {
        broadcasts: [] as DownloadRecord[][],
        told: [] as { hostId: number; id: string; outcome: string }[],
        opened: [] as string[],
        shown: [] as string[],
        marked: [] as string[],
        saved: [] as DownloadRecord[][],
        sync: [] as DownloadRecord[][],
        restarts: [] as string[],
    };
    activeRestarts = log.restarts;
    let seq = 0;
    let clock = 1_000_000;
    const deps: ManagerDeps = {
        store: {
            load: async () => saved,
            save: async (items) => {
                log.saved.push(items.map((r) => ({ ...r })));
            },
            saveSync: (items) => {
                log.sync.push(items.map((r) => ({ ...r })));
            },
        },
        folder: () => Folder,
        askWhere: () => false,
        exists: (file) => files.has(file),
        statMode: async (file) => (files.has(file) ? files.get(file) : null),
        now: () => clock,
        newId: () => `id${++seq}`,
        platform: "linux",
        mark: async (file) => {
            log.marked.push(file);
        },
        openPath: async (file) => {
            log.opened.push(file);
            return "";
        },
        showItem: (file) => {
            log.shown.push(file);
        },
        broadcast: (snapshot) => {
            log.broadcasts.push(snapshot.items.map((r) => ({ ...r })));
        },
        tell: (hostId, record, outcome) => {
            log.told.push({ hostId, id: record.id, outcome });
        },
        startAgain: (url) => {
            log.restarts.push(url);
            return true;
        },
        isHeld: () => false,
        setTimer: (fn, ms) => {
            const timer = { fn, ms, live: true };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            (timer as Timer).live = false;
        },
        ...over,
    };
    const manager = new DownloadManager(deps);
    return {
        manager,
        files,
        log,
        timers,
        tick: (ms: number) => {
            clock += ms;
        },
        // Fires the timers of a given delay once, as the clock would.
        fire(ms: number) {
            for (const timer of timers.filter((t) => t.live && t.ms === ms)) {
                timer.live = false;
                timer.fn();
            }
        },
        last: () => log.broadcasts[log.broadcasts.length - 1] ?? [],
    };
}

const Origin = {
    workspaceId: "ws1",
    tabId: "tab1",
    blockId: "block1",
    browserTabId: "bt1",
    pageUrl: "https://example.com/files",
    pageTitle: "Files",
};

// The restarts of the harness in use: a source starts an address again through its own session.
let activeRestarts: string[] = [];

function webSource(over: Partial<DownloadSource> = {}): DownloadSource {
    return {
        web: true,
        origin: Origin,
        hostId: 7,
        agent: "",
        startAgain: (url) => {
            activeRestarts.push(url);
            return true;
        },
        ...over,
    };
}

// The microtask the manager waits for before it lists a download.
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

async function start(h: ReturnType<typeof makeHarness>, item: FakeItem, source: DownloadSource = webSource()) {
    h.manager.willDownload({}, item, source);
    await settle();
    return h.manager.snapshot().items[0];
}

describe("a download starts (FR-MC-019 AC12)", () => {
    it("is saved straight to the Downloads folder, with no save dialog, and listed with where it came from", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        expect(item.savePath).toBe(path.join(Folder, "report.pdf"));
        expect(item.dialog).toBeNull();
        expect(record).toMatchObject({
            id: "id1",
            url: "https://example.com/files/report.pdf",
            host: "example.com",
            name: "report.pdf",
            state: "progressing",
            total: 1000,
            ...Origin,
        });
    });

    it("never replaces a file that is there: report (1).pdf, and two downloads at once pick two names", async () => {
        const h = makeHarness();
        h.files.set(path.join(Folder, "report.pdf"), 0o644);
        const first = new FakeItem();
        const second = new FakeItem();
        h.manager.willDownload({}, first, webSource());
        h.manager.willDownload({}, second, webSource());
        await settle();
        expect(first.savePath).toBe(path.join(Folder, "report (1).pdf"));
        expect(second.savePath).toBe(path.join(Folder, "report (2).pdf"));
        expect(h.manager.snapshot().items.length).toBe(2);
    });

    it("leaves a download that does not come from a web page to the engine", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        h.manager.willDownload({}, item, { ...webSource(), web: false });
        await settle();
        expect(item.savePath).toBe("");
        expect(item.dialog).toBeNull();
        expect(h.manager.snapshot().items).toEqual([]);
    });

    it("lists the Files panel's Download like a page's, named after its connection (#2163)", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item, {
            ...webSource(),
            origin: { pageTitle: "wsh://dev-box/home/dev/report.pdf" },
            files: { connection: "dev-box" },
        });
        expect(item.savePath).toBe(path.join(Folder, "report.pdf"));
        expect(record).toMatchObject({ host: "dev-box", source: "files", state: "progressing", total: 1000 });
        expect((await start(makeHarness(), new FakeItem())).source).toBe("web");
    });

    it("lists nothing for a download another listener held back (FR-BRW-010)", async () => {
        const held = new FakeItem();
        const h = makeHarness({ isHeld: (item) => item === held });
        h.manager.willDownload({}, held, webSource());
        const prevented = new FakeItem("https://example.com/other.zip", "other.zip");
        h.manager.willDownload({ defaultPrevented: true }, prevented, webSource());
        await settle();
        expect(h.manager.snapshot().items).toEqual([]);
        // The name it chose is free again for the download the user then allows.
        const allowed = new FakeItem();
        h.manager.willDownload({}, allowed, webSource());
        await settle();
        expect(allowed.savePath).toBe(path.join(Folder, "report.pdf"));
    });

    it("names the agent that started a download the user allowed", async () => {
        const h = makeHarness();
        const record = await start(h, new FakeItem(), webSource({ agent: "Jérôme" }));
        expect(record.agent).toBe("Jérôme");
    });

    it("with 'always ask where to save' on, leaves the folder to the engine's dialog and lists the download once it starts", async () => {
        const h = makeHarness({ askWhere: () => true });
        const item = new FakeItem();
        const record = await start(h, item);
        expect(item.savePath).toBe("");
        expect(item.dialog).toEqual({ defaultPath: path.join(Folder, "report.pdf") });
        expect(record.path).toBe("");
        item.savePath = "/elsewhere/chosen-name.pdf";
        item.received = 10;
        item.emit("updated", "progressing");
        expect(h.manager.snapshot().items[0]).toMatchObject({
            path: "/elsewhere/chosen-name.pdf",
            name: "chosen-name.pdf",
        });
    });

    it("lists nothing when that dialog was closed without choosing", async () => {
        const h = makeHarness({ askWhere: () => true });
        const item = new FakeItem();
        await start(h, item);
        item.emit("done", "cancelled");
        expect(h.manager.snapshot().items).toEqual([]);
        expect(h.log.told).toEqual([]);
    });
});

describe("progress (FR-MC-019 AC7)", () => {
    it("follows the bytes, the speed and the pause, and tells the windows a few times a second, never a notification", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        await start(h, item);
        const before = h.log.broadcasts.length;
        for (let i = 1; i <= 50; i++) {
            item.received = i * 10;
            item.speed = 123;
            item.emit("updated", "progressing");
        }
        expect(h.log.broadcasts.length).toBe(before);
        h.fire(BroadcastMs);
        expect(h.log.broadcasts.length).toBe(before + 1);
        expect(h.last()[0]).toMatchObject({ received: 500, bytesPerSecond: 123, state: "progressing" });
        expect(h.log.told).toEqual([]);
    });

    it("pauses and resumes, and a paused download has no speed", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.speed = 50;
        item.emit("updated", "progressing");
        expect(await h.manager.act({ id: record.id, action: "pause" })).toEqual({ ok: true });
        expect(item.calls).toEqual(["pause"]);
        expect(h.last()[0]).toMatchObject({ state: "paused", bytesPerSecond: 0 });
        item.emit("updated", "progressing");
        expect(h.manager.snapshot().items[0].state).toBe("paused");
        expect(await h.manager.act({ id: record.id, action: "resume" })).toEqual({ ok: true });
        expect(item.calls).toEqual(["pause", "resume"]);
        expect(h.last()[0].state).toBe("progressing");
    });

    it("cancels at once, keeps the entry with Retry and raises no notification", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        expect(await h.manager.act({ id: record.id, action: "cancel" })).toEqual({ ok: true });
        expect(item.calls).toEqual(["cancel"]);
        expect(h.last()[0].state).toBe("cancelled");
        item.emit("done", "cancelled");
        expect(h.log.told).toEqual([]);
        expect(h.manager.activeCount()).toBe(0);
    });

    it("has nothing to pause, resume or cancel once it is over", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.savePath = path.join(Folder, "report.pdf");
        item.received = 1000;
        item.emit("done", "completed");
        await settle();
        for (const action of ["pause", "resume", "cancel"] as const) {
            expect(await h.manager.act({ id: record.id, action })).toEqual({ ok: false, error: "failed" });
        }
    });
});

describe("it ends", () => {
    it("completes with one notification, the file marked as downloaded from the internet", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        h.files.set(item.savePath, 0o644);
        item.received = 1000;
        item.emit("done", "completed");
        await settle();
        await settle();
        const done = h.manager.snapshot().items[0];
        expect(done).toMatchObject({
            id: record.id,
            state: "completed",
            received: 1000,
            executable: false,
            endedAt: 1_000_000,
        });
        expect(h.log.marked).toEqual([item.savePath]);
        expect(h.log.told).toEqual([{ hostId: 7, id: record.id, outcome: "done" }]);
    });

    it("tells a program from its name, and from the execute permission when the name says nothing", async () => {
        const h = makeHarness();
        const exe = new FakeItem("https://example.com/setup.exe", "setup.exe");
        await start(h, exe);
        h.files.set(exe.savePath, 0o644);
        exe.emit("done", "completed");
        const bare = new FakeItem("https://example.com/tool", "tool");
        h.manager.willDownload({}, bare, webSource());
        await settle();
        await settle();
        h.files.set(bare.savePath, 0o755);
        bare.emit("done", "completed");
        await settle();
        await settle();
        const byName = Object.fromEntries(h.manager.snapshot().items.map((r) => [r.name, r]));
        expect(byName["setup.exe"].executable).toBe(true);
        expect(byName["tool"].executable).toBe(true);
    });

    it("fails after some bytes as a lost connection, with one notification, however many times the engine says so", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.received = 610;
        item.emit("updated", "interrupted");
        item.emit("done", "interrupted");
        expect(h.manager.snapshot().items[0]).toMatchObject({
            state: "interrupted",
            reason: "connection",
            received: 610,
        });
        expect(h.log.told).toEqual([{ hostId: 7, id: record.id, outcome: "failed" }]);
    });

    it("fails with nothing received as a site that did not send the file", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        await start(h, item);
        item.emit("done", "interrupted");
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "interrupted", reason: "server" });
    });
});

describe("retry (FR-MC-019 AC8)", () => {
    it("resumes where it stopped when the engine can", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.received = 400;
        item.emit("done", "interrupted");
        expect(await h.manager.act({ id: record.id, action: "retry" })).toEqual({ ok: true });
        expect(item.calls).toEqual(["resume"]);
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "progressing", reason: "", received: 400 });
        expect(h.log.restarts).toEqual([]);
        item.received = 1000;
        item.emit("done", "interrupted");
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "interrupted", reason: "noresume" });
        expect(h.log.told.map((t) => t.outcome)).toEqual(["failed", "failed"]);
    });

    it("starts again from zero when the engine cannot resume, and the new download takes the entry's place", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.resumable = false;
        item.received = 400;
        item.emit("done", "interrupted");
        expect(await h.manager.act({ id: record.id, action: "retry" })).toEqual({ ok: true });
        expect(h.log.restarts).toEqual(["https://example.com/files/report.pdf"]);
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "progressing", received: 0 });
        const again = new FakeItem();
        // The restarted download comes from no page: the entry's own record takes it.
        h.manager.willDownload({}, again, { ...webSource(), web: false });
        await settle();
        expect(h.manager.snapshot().items.length).toBe(1);
        expect(h.manager.snapshot().items[0]).toMatchObject({ id: record.id, state: "progressing", ...Origin });
        again.received = 1000;
        again.emit("done", "completed");
        await settle();
        await settle();
        expect(h.manager.snapshot().items[0].state).toBe("completed");
        expect(h.log.told.map((t) => t.outcome)).toEqual(["failed", "done"]);
    });

    it("tells it interrupted when the restarted download never reaches the session", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        item.resumable = false;
        item.emit("done", "interrupted");
        await h.manager.act({ id: record.id, action: "retry" });
        h.fire(RestartWaitMs);
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "interrupted", reason: "server" });
    });

    it("keeps the entry and says it failed when the download cannot be started again", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item, webSource({ startAgain: () => false }));
        item.resumable = false;
        item.emit("done", "interrupted");
        expect(await h.manager.act({ id: record.id, action: "retry" })).toEqual({ ok: false, error: "failed" });
        expect(h.manager.snapshot().items[0].state).toBe("interrupted");
    });
});

describe("the history (FR-MC-019 AC11)", () => {
    it("tells what was running when MoltenTerm quit as interrupted, and keeps the newest 200 within 90 days", async () => {
        const closed = Array.from({ length: 205 }, (_, i) => ({
            ...recordShape(`c${i}`),
            startedAt: 999_000_000 + i,
            endedAt: 999_000_100 + i,
        }));
        const old = { ...recordShape("old"), startedAt: 1, endedAt: 2 };
        const running = { ...recordShape("run"), state: "progressing", endedAt: 0, startedAt: 999_500_000 };
        const h = makeHarness({ now: () => 1_000_000_000 }, { version: 1, items: [...closed, old, running] });
        await h.manager.restore();
        const items = h.manager.snapshot().items;
        expect(items.length).toBe(200);
        expect(items.some((r) => r.id === "old")).toBe(false);
        expect(items.find((r) => r.id === "run")).toMatchObject({ state: "interrupted", reason: "appclosed" });
        h.fire(SaveDelayMs);
        expect(h.log.saved.length).toBe(1);
    });

    it("writes the history at quit without waiting for the next tick", async () => {
        const h = makeHarness();
        await start(h, new FakeItem());
        h.manager.flushSync();
        expect(h.log.sync.length).toBe(1);
        expect(h.log.sync[0].map((r) => r.id)).toEqual(["id1"]);
    });

    it("clears what is over, never a running download, and touches no file", async () => {
        const h = makeHarness();
        const done = new FakeItem("https://example.com/a.pdf", "a.pdf");
        await start(h, done);
        h.files.set(done.savePath, 0o644);
        done.emit("done", "completed");
        await settle();
        await settle();
        const running = new FakeItem("https://example.com/b.zip", "b.zip");
        h.manager.willDownload({}, running, webSource());
        await settle();
        const filesBefore = new Map(h.files);
        expect(await h.manager.clear()).toBe(1);
        expect(h.manager.snapshot().items.map((r) => r.name)).toEqual(["b.zip"]);
        expect(h.files).toEqual(filesBefore);
        expect(h.log.opened).toEqual([]);
    });

    it("removes one finished entry and refuses to remove one that runs", async () => {
        const h = makeHarness();
        const item = new FakeItem();
        const record = await start(h, item);
        expect(await h.manager.act({ id: record.id, action: "remove" })).toEqual({ ok: false, error: "failed" });
        item.emit("done", "completed");
        await settle();
        await settle();
        expect(await h.manager.act({ id: record.id, action: "remove" })).toEqual({ ok: true });
        expect(h.manager.snapshot().items).toEqual([]);
    });
});

describe("the file (FR-MC-019 AC8)", () => {
    async function finished(h: ReturnType<typeof makeHarness>, item = new FakeItem(), mode = 0o644) {
        const record = await start(h, item);
        h.files.set(item.savePath, mode);
        item.received = 1000;
        item.emit("done", "completed");
        await settle();
        await settle();
        return { record, item };
    }

    it("opens a finished file and shows it in its folder", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h);
        expect(await h.manager.act({ id: record.id, action: "open" })).toEqual({ ok: true });
        expect(await h.manager.act({ id: record.id, action: "reveal" })).toEqual({ ok: true });
        expect(h.log.opened).toEqual([item.savePath]);
        expect(h.log.shown).toEqual([item.savePath]);
    });

    it("shows a moved or deleted file as such, and answers Open and Show with a code instead of a failure", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h);
        h.files.delete(item.savePath);
        await h.manager.check();
        expect(h.manager.snapshot().items[0].missing).toBe(true);
        expect(await h.manager.act({ id: record.id, action: "open" })).toEqual({ ok: false, error: "missing" });
        expect(await h.manager.act({ id: record.id, action: "reveal" })).toEqual({ ok: false, error: "missing" });
        expect(h.log.opened).toEqual([]);
        expect(h.log.shown).toEqual([]);
        // It comes back with the file.
        h.files.set(item.savePath, 0o644);
        await h.manager.check();
        expect(h.manager.snapshot().items[0].missing).toBe(false);
    });

    it("finds out the file is gone at the moment of the click, without waiting for a check", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h);
        h.files.delete(item.savePath);
        expect(await h.manager.act({ id: record.id, action: "open" })).toEqual({ ok: false, error: "missing" });
        expect(h.manager.snapshot().items[0].missing).toBe(true);
    });

    it("downloads a file that is gone again, under the same entry", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h);
        h.files.delete(item.savePath);
        await h.manager.check();
        expect(await h.manager.act({ id: record.id, action: "retry" })).toEqual({ ok: true });
        expect(h.log.restarts).toEqual(["https://example.com/files/report.pdf"]);
        expect(h.manager.snapshot().items[0]).toMatchObject({ state: "progressing", missing: false });
    });

    it("asks before it opens a program, in the main process, whatever the window says", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h, new FakeItem("https://example.com/setup.exe", "setup.exe"));
        expect(await h.manager.act({ id: record.id, action: "open" })).toEqual({ ok: false, error: "executable" });
        expect(h.log.opened).toEqual([]);
        expect(await h.manager.act({ id: record.id, action: "open", confirmed: true })).toEqual({ ok: true });
        expect(h.log.opened).toEqual([item.savePath]);
        // Showing it in the folder never asks: nothing runs.
        expect(await h.manager.act({ id: record.id, action: "reveal" })).toEqual({ ok: true });
    });

    it("asks for a file that became a program after it was saved", async () => {
        const h = makeHarness();
        const { record, item } = await finished(h);
        h.files.set(item.savePath, 0o755);
        expect(await h.manager.act({ id: record.id, action: "open" })).toEqual({ ok: false, error: "executable" });
    });

    it("answers an unknown entry with a code and opens the Downloads folder on request", async () => {
        const h = makeHarness();
        expect(await h.manager.act({ id: "nope", action: "open" })).toEqual({ ok: false, error: "noitem" });
        expect(await h.manager.act({ action: "openfolder" })).toEqual({ ok: true });
        expect(h.log.opened).toEqual([Folder]);
    });
});

function recordShape(id: string) {
    return {
        id,
        url: `https://example.com/${id}`,
        host: "example.com",
        name: `${id}.pdf`,
        path: `/dl/${id}.pdf`,
        mime: "application/pdf",
        state: "completed",
        received: 10,
        total: 10,
        startedAt: 1,
        endedAt: 2,
        reason: "",
        executable: false,
        agent: "",
        workspaceId: "ws",
        tabId: "tab",
        blockId: "blk",
        browserTabId: "bt",
        pageUrl: "https://example.com",
        pageTitle: "t",
    };
}
