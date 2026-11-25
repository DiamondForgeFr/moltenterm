// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
    state: { client: null as any, writes: [] as { oref: string; meta: Record<string, any> }[], fail: false },
}));

vi.mock("@/app/store/client-model", () => ({
    ClientModel: { getInstance: () => ({ clientAtom: { name: "client" }, clientId: "c1" }) },
}));
vi.mock("@/app/store/global", () => ({ globalStore: { get: () => state.client } }));
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: unknown, data: { oref: string; meta: Record<string, any> }) => {
            if (state.fail) {
                throw new Error("offline");
            }
            state.writes.push(data);
            state.client = { ...state.client, meta: { ...state.client.meta, ...data.meta } };
        },
    },
}));

import { LevelApp, LevelProject, LevelWorkspace, projectPlaceId } from "./bookmarks";
import {
    BookmarkPrefsMetaKey,
    noteRecentPlace,
    readPrefs,
    RecentPlacesMax,
    savePanelWidth,
    withRecentPlace,
} from "./bookmark-prefs";

beforeEach(() => {
    state.client = { oid: "c1", meta: {} };
    state.writes = [];
    state.fail = false;
});

describe("the small preferences of the bookmark surfaces, kept in the client's meta (#1763)", () => {
    it("reads nothing from a client without them or with a broken value", () => {
        expect(readPrefs(null)).toEqual({ width: 0, recent: [] });
        expect(readPrefs({})).toEqual({ width: 0, recent: [] });
        expect(readPrefs({ [BookmarkPrefsMetaKey]: "x" })).toEqual({ width: 0, recent: [] });
        expect(readPrefs({ [BookmarkPrefsMetaKey]: { width: "wide", recent: "w1" } })).toEqual({ width: 0, recent: [] });
        expect(readPrefs({ [BookmarkPrefsMetaKey]: { width: -3 } }).width).toBe(0);
    });

    it("keeps only well formed place keys, once each, up to the limit", () => {
        const recent = ["workspace:w1", "nonsense", "workspace:w1", 4, "project:w1/p1", "context:c1", "app", "workspace:w2", "workspace:w3", "workspace:w4"];
        const read = readPrefs({ [BookmarkPrefsMetaKey]: { width: 612.4, recent } });
        expect(read.width).toBe(612);
        expect(read.recent).toEqual(["workspace:w1", "project:w1/p1", "context:c1", "app", "workspace:w2", "workspace:w3"]);
        expect(read.recent).toHaveLength(RecentPlacesMax);
    });

    it("puts the place just used first, once", () => {
        const next = withRecentPlace(["workspace:w1", "workspace:w2"], { level: LevelWorkspace, id: "w2" });
        expect(next).toEqual(["workspace:w2", "workspace:w1"]);
        expect(withRecentPlace(next, { level: LevelApp, id: "" })).toEqual(["app", "workspace:w2", "workspace:w1"]);
        const long = Array.from({ length: RecentPlacesMax }, (_, i) => `workspace:w${i}`);
        expect(withRecentPlace(long, { level: LevelProject, id: projectPlaceId("w9", "p1") })).toHaveLength(
            RecentPlacesMax
        );
    });

    it("writes them on the client object, one key, each write building on the last", async () => {
        await noteRecentPlace({ level: LevelWorkspace, id: "w2" });
        await savePanelWidth(702.6);
        await noteRecentPlace({ level: LevelProject, id: projectPlaceId("w1", "p2") });
        expect(state.writes.map((w) => w.oref)).toEqual(["client:c1", "client:c1", "client:c1"]);
        expect(state.writes.every((w) => Object.keys(w.meta).join() === BookmarkPrefsMetaKey)).toBe(true);
        expect(readPrefs(state.client.meta)).toEqual({ width: 703, recent: ["project:w1/p2", "workspace:w2"] });
    });

    it("loses a preference, never a bookmark, when a write fails", async () => {
        state.fail = true;
        await expect(noteRecentPlace({ level: LevelWorkspace, id: "w2" })).resolves.toBeUndefined();
        expect(state.writes).toEqual([]);
    });
});
