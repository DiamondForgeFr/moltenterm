// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const gestures = new Map<string, (args: Record<string, any>) => Promise<any>>();
const published: any[] = [];
let notifyListener: (notice: { record: any; outcome: "done" | "failed" }) => void = null;
const act = vi.fn();

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws-origin" }) },
        getApi: () => ({
            moltentermDownloadsAct: act,
            moltentermDownloadsList: () => new Promise(() => {}),
            onMoltentermDownloadsChanged: () => () => {},
            onMoltentermDownloadsNotify: (cb: typeof notifyListener) => {
                notifyListener = cb;
                return () => {
                    notifyListener = null;
                };
            },
        }),
    };
});
vi.mock("@/app/store/services", () => ({ ObjectService: {}, WorkspaceService: {} }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    return { activeTabIdAtom: atom("tab-origin") };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../notifications-store", () => ({
    registerNotificationGesture: (name: string, fn: (args: Record<string, any>) => Promise<any>) => {
        gestures.set(name, fn);
        return () => gestures.delete(name);
    },
    MoltentermNotifications: { getInstance: () => ({ publish: (input: any) => published.push(input) }) },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { DownloadRecord } from "./downloads-model";
import {
    downloadNotification,
    DownloadOpenGesture,
    DownloadRetryGesture,
    DownloadRevealGesture,
    DownloadShowGesture,
    startDownloads,
} from "./downloads-notify";
import { DownloadsModel } from "./downloads-store";

function record(over: Partial<DownloadRecord> = {}): DownloadRecord {
    return {
        id: "d1",
        url: "https://compta.example.com/rapport-q3.pdf",
        host: "compta.example.com",
        name: "rapport-q3.pdf",
        path: "/dl/rapport-q3.pdf",
        mime: "application/pdf",
        state: "completed",
        received: 4_200_000,
        total: 4_200_000,
        bytesPerSecond: 0,
        startedAt: 1,
        endedAt: 2,
        reason: "",
        executable: false,
        missing: false,
        agent: "",
        workspaceId: "ws",
        tabId: "tab",
        blockId: "blk",
        browserTabId: "bt",
        pageUrl: "https://compta.example.com/files",
        pageTitle: "Compta",
        ...over,
    };
}

beforeEach(() => {
    vi.stubGlobal("window", {});
    gestures.clear();
    published.length = 0;
    act.mockReset();
    DownloadsModel.resetInstance();
});

describe("what a download tells the notification center (FR-MC-019 AC10)", () => {
    it("tells a finished download once, with Open and Show in folder", () => {
        const n = downloadNotification(record(), "done", false);
        expect(n).toMatchObject({
            key: "download:d1",
            source: "download",
            kind: "success",
            global: true,
            read: false,
            title: "Download finished: rapport-q3.pdf",
        });
        expect(n.actions.map((a) => [a.label, a.gesture])).toEqual([
            ["Open", DownloadOpenGesture],
            ["Show in folder", DownloadRevealGesture],
        ]);
        expect(n.message).toContain("compta.example.com");
    });

    it("sends a program to its entry, where the confirmation is, and says why", () => {
        const n = downloadNotification(record({ name: "setup.exe", executable: true }), "done", false);
        expect(n.actions.map((a) => [a.label, a.gesture, a.args])).toEqual([
            ["View", DownloadShowGesture, { id: "d1", confirm: true }],
            ["Show in folder", DownloadRevealGesture, { id: "d1" }],
        ]);
        expect(n.message).toBe("It is a program: opening it asks you to confirm.");
    });

    it("arrives already read when the Downloads section is open, never for a failure", () => {
        expect(downloadNotification(record(), "done", true).read).toBe(true);
        expect(
            downloadNotification(record({ state: "interrupted", reason: "server" }), "failed", true).read
        ).toBeUndefined();
    });

    it("tells a failure once, as an error, with Retry and View and the reason in words", () => {
        const n = downloadNotification(
            record({ state: "interrupted", reason: "connection", received: 610, total: 1000 }),
            "failed",
            false
        );
        expect(n).toMatchObject({ key: "download:d1", kind: "error", title: "Download interrupted: rapport-q3.pdf" });
        expect(n.message).toBe("The connection was lost at 61%");
        expect(n.actions.map((a) => a.gesture)).toEqual([DownloadRetryGesture, DownloadShowGesture]);
    });

    it("names the agent that started the download", () => {
        expect(downloadNotification(record({ agent: "Jérôme" }), "done", false).message).toContain("Started by Jérôme");
    });
});

describe("what main tells the window that hosts the page", () => {
    it("publishes what main sends, and nothing is published while a download progresses", () => {
        const stop = startDownloads();
        expect(notifyListener).not.toBeNull();
        notifyListener({ record: record(), outcome: "done" });
        expect(published.length).toBe(1);
        expect(published[0].title).toBe("Download finished: rapport-q3.pdf");
        stop();
        expect(notifyListener).toBeNull();
    });

    it("raises a finished download already read while the section is open", () => {
        const stop = startDownloads();
        const model = DownloadsModel.getInstance();
        model.setVisible(1);
        notifyListener({ record: record(), outcome: "done" });
        expect(published[0].read).toBe(true);
        model.setVisible(-1);
        notifyListener({ record: record({ id: "d2" }), outcome: "done" });
        expect(published[1].read).toBe(false);
        stop();
    });
});

describe("the actions of a notification", () => {
    function withItems(items: DownloadRecord[]) {
        const model = DownloadsModel.getInstance();
        globalStore.set(model.snapshotAtom, { items, folder: "/dl", askWhere: false });
        return model;
    }

    it("opens a download, and answers in words when the file is gone", async () => {
        withItems([record()]);
        const stop = startDownloads();
        act.mockResolvedValueOnce({ ok: true });
        expect(await gestures.get(DownloadOpenGesture)({ id: "d1" })).toEqual({ ok: true, resolve: false });
        expect(act).toHaveBeenCalledWith({ id: "d1", action: "open" });
        act.mockResolvedValueOnce({ ok: false, error: "missing" });
        expect(await gestures.get(DownloadOpenGesture)({ id: "d1" })).toEqual({
            ok: false,
            error: "The file was moved or deleted.",
        });
        stop();
    });

    it("sends a program to its entry instead of failing, and asks the section to show it with its confirmation", async () => {
        const model = withItems([record({ name: "setup.exe", executable: true })]);
        const stop = startDownloads();
        act.mockResolvedValueOnce({ ok: false, error: "executable" });
        expect(await gestures.get(DownloadOpenGesture)({ id: "d1" })).toEqual({ ok: true });
        expect(globalStore.get(model.requestAtom)).toMatchObject({ id: "d1", confirm: true });
        stop();
    });

    it("records no failure for the question that comes before opening a program, and one for anything else", async () => {
        const model = withItems([record({ name: "setup.exe", executable: true })]);
        act.mockResolvedValueOnce({ ok: false, error: "executable" });
        await model.act({ id: "d1", action: "open" });
        expect(globalStore.get(model.errorsAtom)).toEqual({});
        act.mockResolvedValueOnce({ ok: false, error: "missing" });
        await model.act({ id: "d1", action: "open" });
        expect(globalStore.get(model.errorsAtom)).toEqual({ d1: "missing" });
        act.mockResolvedValueOnce({ ok: true });
        await model.act({ id: "d1", action: "reveal" });
        expect(globalStore.get(model.errorsAtom)).toEqual({});
    });

    it("retries, and closes the failure it answers", async () => {
        withItems([record({ state: "interrupted" })]);
        const stop = startDownloads();
        act.mockResolvedValueOnce({ ok: true });
        expect(await gestures.get(DownloadRetryGesture)({ id: "d1" })).toEqual({ ok: true, resolve: true });
        stop();
    });

    it("asks the section to show an entry, never opening anything by itself", async () => {
        const model = withItems([record()]);
        const stop = startDownloads();
        expect(await gestures.get(DownloadShowGesture)({ id: "d1" })).toEqual({ ok: true });
        expect(globalStore.get(model.requestAtom)).toMatchObject({ id: "d1", confirm: false });
        expect(act).not.toHaveBeenCalled();
        stop();
    });

    it("answers an entry that was removed since with a code instead of failing", async () => {
        withItems([]);
        const stop = startDownloads();
        expect(await gestures.get(DownloadRevealGesture)({ id: "gone" })).toEqual({
            ok: false,
            error: "This download is no longer in the list.",
        });
        expect(await gestures.get(DownloadShowGesture)({ id: "gone" })).toEqual({
            ok: false,
            error: "This download is no longer in the list.",
        });
        stop();
    });
});
