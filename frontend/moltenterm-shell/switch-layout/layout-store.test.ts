// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// The backend as a restarted app finds it: the workspaces and their meta, nothing else.
const backend = vi.hoisted(() => ({ meta: new Map<string, Record<string, any>>(), writes: [] as any[] }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getObjectValue: (oref: string) => {
        const meta = backend.meta.get(oref);
        return meta == null ? null : { oid: oref.split(":")[1], meta };
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: unknown, data: { oref: string; meta: Record<string, any> }) => {
            backend.writes.push(data);
            // What wavesrv stores is JSON: the meta comes back as plain data.
            const stored = JSON.parse(JSON.stringify(data.meta));
            backend.meta.set(data.oref, { ...(backend.meta.get(data.oref) ?? {}), ...stored });
        },
    },
}));

import { contentBoxFor, measureLayout, overlapArea, scaleLayout } from "./layout-memory";
import { LayoutMetaKey, loadLayout, saveLayout } from "./layout-store";

const Window = { width: 1600, height: 1000 };
const Content = { left: 268, top: 8, width: 1324, height: 984 };
const Blocks = [
    { id: "term-1", kind: "term", rect: { left: 268, top: 8, width: 662, height: 984 } },
    { id: "web-1", kind: "web", rect: { left: 930, top: 8, width: 662, height: 492 } },
    { id: "panel-1", kind: "preview", rect: { left: 930, top: 500, width: 662, height: 492 } },
];

describe("the remembered layout outlives a restart (FR-SHELL-082, #2407)", () => {
    beforeEach(() => {
        backend.meta.clear();
        backend.writes.length = 0;
    });

    it("is kept on the workspace, and a restarted app with no page storage draws it scaled to a smaller window", async () => {
        saveLayout(measureLayout("ws-alpha", "tab-1", Content, Window, Blocks, 1));
        await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
        expect(backend.writes[0].oref).toBe("workspace:ws-alpha");
        expect(Object.keys(backend.writes[0].meta)).toEqual([LayoutMetaKey]);
        // The restart: the pages' storage is gone (none in this process), the workspace's meta is what is left.
        const read = loadLayout("ws-alpha");
        expect(read?.panels.map((p) => p.kind)).toEqual(["term", "web", "preview"]);
        const small = { width: 1000, height: 700 };
        const frames = scaleLayout(read, contentBoxFor(read, small));
        expect(frames.map((f) => f.rect)).toEqual([
            { left: 268, top: 8, width: 362, height: 684 },
            { left: 630, top: 8, width: 362, height: 342 },
            { left: 630, top: 350, width: 362, height: 342 },
        ]);
        for (let i = 0; i < frames.length; i++) {
            expect(frames[i].rect.left + frames[i].rect.width).toBeLessThanOrEqual(small.width);
            for (let j = i + 1; j < frames.length; j++) {
                expect(overlapArea(frames[i].rect, frames[j].rect)).toBe(0);
            }
        }
    });

    it("reads nothing for a workspace that never kept one, nor another workspace's", () => {
        backend.meta.set("workspace:ws-beta", { [LayoutMetaKey]: { workspaceId: "ws-alpha", panels: [] } });
        expect(loadLayout("ws-beta")).toBeNull();
        expect(loadLayout("ws-gamma")).toBeNull();
        expect(loadLayout("")).toBeNull();
    });
});
