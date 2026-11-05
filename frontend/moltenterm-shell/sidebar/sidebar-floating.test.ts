// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1951: in a view whose object updates no longer arrive (its event subscription was lost after a websocket
// reconnect), every entry point still switches the sidebar between docked and floating, and the edge reveals it.
// The update events never come here: wavesrv is a fake that keeps the window and answers GetObject with it.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ window: null as WaveWindow }));

vi.mock("@/util/fetchutil", () => ({
    fetch: async (_url: string, init: { body: string }) => {
        const call = JSON.parse(init.body);
        const data = call.service === "object" && call.method === "GetObject" ? server.window : null;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
    },
}));

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { findShortcut } from "../shortcuts/registry";
import { registerSidebarKeys, ToggleSidebarShortcutId } from "./sidebar-keys";
import { SidebarHiddenMetaKey } from "./sidebar-model";
import { SidebarModel } from "./sidebar-store";

const WindowId = "win-1951";
const WindowORef = `window:${WindowId}`;

function storedHidden(): boolean {
    return server.window.meta?.[SidebarHiddenMetaKey] === true;
}

// wavesrv's SetMetaCommand: the window changes on the server, and no update event reaches the view.
function fakeSetMeta() {
    return vi.spyOn(RpcApi, "SetMetaCommand").mockImplementation(async (_client, data) => {
        if (data.oref === WindowORef) {
            server.window = {
                ...server.window,
                version: server.window.version + 1,
                meta: { ...server.window.meta, ...data.meta },
            };
        }
    });
}

async function settled(sidebar: SidebarModel) {
    await vi.waitFor(() => expect(globalStore.get(sidebar.pendingHiddenAtom)).toBeNull(), { timeout: 30_000 });
}

describe("switching the sidebar to floating in a view that receives no updates (#1951)", () => {
    const sidebar = SidebarModel.getInstance();

    beforeAll(() => {
        initGlobalAtoms({ tabId: "tab-1951", windowId: WindowId, clientId: "client-1", platform: "darwin" } as any);
    });

    beforeEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        // Versions only grow: the view keeps the newest object it has seen.
        const version = (server.window?.version ?? 0) + 1;
        server.window = { otype: "window", oid: WindowId, version, meta: { [SidebarHiddenMetaKey]: false } } as any;
        WOS.updateWaveObject({ updatetype: "update", otype: "window", oid: WindowId, obj: server.window });
        globalStore.set(sidebar.peekAtom, false);
        fakeSetMeta();
        await WOS.reloadWaveObject(WindowORef);
        expect(sidebar.isHidden()).toBe(false);
    });

    it("the sidebar button floats it, and docks it again", async () => {
        sidebar.toggleHidden();
        await settled(sidebar);
        expect(storedHidden()).toBe(true);
        expect(sidebar.isHidden()).toBe(true);

        sidebar.toggleHidden();
        await settled(sidebar);
        expect(storedHidden()).toBe(false);
        expect(sidebar.isHidden()).toBe(false);
    });

    it("the keyboard shortcut floats it, and docks it again", async () => {
        vi.stubGlobal("document", { activeElement: null });
        const keyMap = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerSidebarKeys(keyMap);
        const press = keyMap.get(findShortcut(ToggleSidebarShortcutId).keys);
        expect(press(null)).toBe(true);
        await settled(sidebar);
        expect(storedHidden()).toBe(true);
        expect(sidebar.isHidden()).toBe(true);

        expect(press(null)).toBe(true);
        await settled(sidebar);
        expect(storedHidden()).toBe(false);
        expect(sidebar.isHidden()).toBe(false);
    });

    it("the settings choice Floating sticks", async () => {
        sidebar.setHidden(true);
        await settled(sidebar);
        expect(storedHidden()).toBe(true);
        expect(sidebar.isHidden()).toBe(true);
    });

    it("once floating, the edge reveals it", async () => {
        sidebar.setHidden(true);
        await settled(sidebar);
        sidebar.setPeek(true);
        expect(sidebar.isHidden()).toBe(true);
        expect(globalStore.get(sidebar.peekAtom)).toBe(true);
    });
});
