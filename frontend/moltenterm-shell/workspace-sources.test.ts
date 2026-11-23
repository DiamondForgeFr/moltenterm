// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    list: [] as { workspaceid: string; windowid?: string }[],
    workspaces: {} as Record<string, { oid: string } | null>,
    listCalls: 0,
    getCalls: [] as string[],
    // While set, GetWorkspace answers only when released, so the test sees how many were asked at once.
    hold: null as Promise<void>,
    onEvent: null as () => void,
    busThrows: false,
}));

vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { get: () => ({}) } }));
vi.mock("@/app/store/wos", () => ({
    getWaveObjectAtom: (oref: string) => ({ oref }),
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
}));
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        ListWorkspaces: async () => {
            h.listCalls++;
            return h.list;
        },
        GetWorkspace: async (id: string) => {
            h.getCalls.push(id);
            if (h.hold != null) {
                await h.hold;
            }
            if (h.workspaces[id] === undefined) {
                throw new Error(`no workspace ${id}`);
            }
            return h.workspaces[id];
        },
    },
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: () => void }) => {
        if (h.busThrows) {
            throw new Error("no event bus");
        }
        h.onEvent = sub.handler;
        return () => {};
    },
}));

import {
    loadWorkspaceSources,
    readWorkspaceSources,
    resetWorkspaceSourcesForTest,
    subscribeWorkspaceSources,
} from "./workspace-sources";

// Waits for what is read asynchronously: it polls, with a deadline that only bounds a failing run.
const until = (check: () => void) => vi.waitFor(check, { timeout: 30000, interval: 2 });

beforeEach(() => {
    resetWorkspaceSourcesForTest();
    h.list = [{ workspaceid: "a" }, { workspaceid: "b", windowid: "w1" }, { workspaceid: "c" }];
    h.workspaces = { a: { oid: "a" }, b: { oid: "b" }, c: { oid: "c" } };
    h.listCalls = 0;
    h.getCalls = [];
    h.hold = null;
    h.onEvent = null;
    h.busThrows = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the workspaces a page reads (#2476)", () => {
    it("reads the list once and each workspace once, with the window that shows it", async () => {
        const sources = await readWorkspaceSources();
        expect(sources.map((s) => [s.workspace.oid, s.windowId ?? ""])).toEqual([
            ["a", ""],
            ["b", "w1"],
            ["c", ""],
        ]);
        expect(h.listCalls).toBe(1);
        expect(h.getCalls.slice().sort()).toEqual(["a", "b", "c"]);
    });

    it("asks for every workspace at once, not one after the other", async () => {
        let release: () => void;
        h.hold = new Promise<void>((resolve) => (release = resolve));
        const read = readWorkspaceSources();
        await until(() => expect(h.getCalls.slice().sort()).toEqual(["a", "b", "c"]));
        release();
        expect((await read).length).toBe(3);
    });

    it("leaves out a workspace that cannot be read", async () => {
        delete h.workspaces.b;
        h.workspaces.c = null;
        const sources = await readWorkspaceSources();
        expect(sources.map((s) => s.workspace.oid)).toEqual(["a"]);
    });

    it("serves every reader from one read until a workspace changes", async () => {
        await readWorkspaceSources();
        await readWorkspaceSources();
        await readWorkspaceSources();
        expect(h.listCalls).toBe(1);
        expect(h.getCalls.length).toBe(3);
        h.onEvent();
        await readWorkspaceSources();
        await readWorkspaceSources();
        expect(h.listCalls).toBe(2);
        expect(h.getCalls.length).toBe(6);
    });

    it("shares a read that is running with those who ask while nothing changed since it began", async () => {
        let release: () => void;
        h.hold = new Promise<void>((resolve) => (release = resolve));
        const first = readWorkspaceSources();
        const second = readWorkspaceSources();
        const third = readWorkspaceSources();
        await until(() => expect(h.getCalls.length).toBe(3));
        release();
        await Promise.all([first, second, third]);
        expect(h.listCalls).toBe(1);
        expect(h.getCalls.length).toBe(3);
    });

    it("reads once more, for all of them, when a change comes while a read runs", async () => {
        let release: () => void;
        h.hold = new Promise<void>((resolve) => (release = resolve));
        const first = readWorkspaceSources();
        await until(() => expect(h.getCalls.length).toBe(3));
        h.onEvent();
        const second = readWorkspaceSources();
        const third = readWorkspaceSources();
        release();
        h.hold = null;
        await Promise.all([first, second, third]);
        expect(h.listCalls).toBe(2);
    });

    it("reads again on request, whatever was heard", async () => {
        await readWorkspaceSources();
        await readWorkspaceSources({ fresh: true });
        await loadWorkspaceSources();
        expect(h.listCalls).toBe(3);
    });

    it("goes to wavesrv every time when the page has no event bus", async () => {
        h.busThrows = true;
        await readWorkspaceSources();
        await readWorkspaceSources();
        expect(h.listCalls).toBe(2);
    });
});

describe("the readers that follow the workspaces", () => {
    it("tell every reader what one read found: a change costs one read, not one per reader", async () => {
        const seenBySidebar: string[][] = [];
        const seenByScope: string[][] = [];
        const stopSidebar = subscribeWorkspaceSources((s) => seenBySidebar.push(s.map((x) => x.workspace.oid)));
        const stopScope = subscribeWorkspaceSources((s) => seenByScope.push(s.map((x) => x.workspace.oid)));
        await until(() => expect(seenBySidebar.length).toBe(1));
        expect(seenByScope[0]).toEqual(["a", "b", "c"]);
        expect(h.listCalls).toBe(1);

        h.workspaces.d = { oid: "d" };
        h.list = [...h.list, { workspaceid: "d" }];
        h.onEvent();
        await until(() => expect(seenByScope.length).toBe(2));
        expect(seenBySidebar[1]).toEqual(["a", "b", "c", "d"]);
        expect(h.listCalls).toBe(2);
        stopSidebar();
        stopScope();
    });

    it("gives a reader that comes late the last read at once, without reading again", async () => {
        await readWorkspaceSources();
        const seen: string[][] = [];
        const stop = subscribeWorkspaceSources((s) => seen.push(s.map((x) => x.workspace.oid)));
        expect(seen).toEqual([["a", "b", "c"]]);
        await readWorkspaceSources();
        expect(h.listCalls).toBe(1);
        stop();
    });

    it("stops telling a reader that stopped, and reads no more for a change nobody follows", async () => {
        const seen: number[] = [];
        const stop = subscribeWorkspaceSources((s) => seen.push(s.length));
        await until(() => expect(seen.length).toBe(1));
        stop();
        h.onEvent();
        await readWorkspaceSources({ fresh: false });
        expect(seen.length).toBe(1);
        expect(h.listCalls).toBe(2);
    });

    it("lets one reader fail without keeping the others from their news", async () => {
        const seen: number[] = [];
        subscribeWorkspaceSources(() => {
            throw new Error("a reader failed");
        });
        subscribeWorkspaceSources((s) => seen.push(s.length));
        await until(() => expect(seen).toEqual([3]));
    });
});
