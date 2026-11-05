// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view kept alive across a websocket reconnect reads its objects again (#1950): the workspace's views list, a tab's
// panes and the window's meta updated while it was cut off reach it, without a reload.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetWosResyncForTest, startWosResync } from "./wos-resync";
import { reconnectHandler } from "./ws-resubscribe";

const m = vi.hoisted(() => ({
    server: new Map<string, any>(),
    asked: [] as string[][],
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
// wavesrv's object service: GetObject goes through the web call, GetObjects through ObjectService.
vi.mock("@/util/fetchutil", () => ({
    fetch: async (_url: string, init: { body: string }) => {
        const call = JSON.parse(init.body);
        return { ok: true, json: async () => ({ data: m.server.get(call.args[0]) ?? null }) };
    },
}));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://test" }));
vi.mock("@/app/store/services", () => ({
    ObjectService: {
        GetObjects: async (orefs: string[]) => {
            m.asked.push(orefs);
            return orefs.map((oref) => m.server.get(oref)).filter((v) => v != null);
        },
    },
}));

function serve(obj: { otype: string; oid: string; version: number; [k: string]: any }) {
    m.server.set(`${obj.otype}:${obj.oid}`, obj);
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    m.server.clear();
    m.asked.length = 0;
    resetWosResyncForTest();
});

describe("objects read again after a reconnect (#1950)", () => {
    it("the workspace, its tabs and the window's meta changed while the view was cut off show at once", async () => {
        serve({ otype: "workspace", oid: "ws1", version: 1, tabids: ["t1"] });
        serve({ otype: "tab", oid: "t1", version: 1, name: "Cadrage", blockids: ["b1"] });
        serve({ otype: "window", oid: "w1", version: 1, meta: {} });
        for (const oref of ["workspace:ws1", "tab:t1", "window:w1"]) {
            await WOS.loadAndPinWaveObject(oref);
        }
        startWosResync();

        // While the websocket was down: a new view, a new pane, the sidebar switched to floating.
        serve({ otype: "workspace", oid: "ws1", version: 2, tabids: ["t1", "t2"] });
        serve({ otype: "tab", oid: "t1", version: 2, name: "Cadrage", blockids: ["b1", "b2"] });
        serve({ otype: "window", oid: "w1", version: 2, meta: { "molten:sidebarfloating": true } });
        expect(globalStore.get(WOS.getWaveObjectAtom<Workspace>("workspace:ws1")).tabids).toEqual(["t1"]);

        reconnectHandler(
            () => {},
            () => {}
        )();
        await settle();
        expect(m.asked).toHaveLength(1);
        expect(globalStore.get(WOS.getWaveObjectAtom<Workspace>("workspace:ws1")).tabids).toEqual(["t1", "t2"]);
        expect(globalStore.get(WOS.getWaveObjectAtom<Tab>("tab:t1")).blockids).toEqual(["b1", "b2"]);
        expect(globalStore.get(WOS.getWaveObjectAtom<WaveWindow>("window:w1")).meta).toEqual({
            "molten:sidebarfloating": true,
        });
    });

    it("never replaces an update that arrived while the objects were read again", async () => {
        serve({ otype: "tab", oid: "t9", version: 1, name: "Old" });
        await WOS.loadAndPinWaveObject("tab:t9");
        WOS.updateWaveObject({
            updatetype: "update",
            otype: "tab",
            oid: "t9",
            obj: { otype: "tab", oid: "t9", version: 5, name: "Newest" } as any,
        });

        const reloaded = await WOS.reloadCachedWaveObjects(["tab"]);
        expect(reloaded).toBeGreaterThan(0);
        expect(globalStore.get(WOS.getWaveObjectAtom<Tab>("tab:t9")).name).toBe("Newest");
    });
});
