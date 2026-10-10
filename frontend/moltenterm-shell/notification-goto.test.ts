// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    setMeta: null as any,
    setActiveTab: null as any,
    switchWorkspace: null as any,
    focusNode: null as any,
}));

vi.mock("@/app/store/client-model", () => ({
    ClientModel: { getInstance: () => ({ clientAtom: null, clientId: "client" }) },
}));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws", tabids: ["tab1", "tab2"] }) },
        getApi: () => ({ setActiveTab: app.setActiveTab, switchWorkspace: app.switchWorkspace }),
        getFocusedBlockId: () => null,
    };
});
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    return { activeTabIdAtom: atom("tab1") };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { SetMetaCommand: (...args: any[]) => app.setMeta(...args) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/layout/index", () => ({
    getLayoutModelForStaticTab: () => ({
        getNodeByBlockId: (blockId: string) => (blockId === "here" ? { id: "node-here" } : null),
        focusNode: (id: string) => app.focusNode(id),
    }),
}));
vi.mock("./open-view", () => ({ openMoltentermView: vi.fn() }));
vi.mock("./project/project-model", () => ({ checkProjectRoute: () => false, checkProjectSource: () => false }));
vi.mock("./project/project-tab", () => ({ showProjectTab: vi.fn() }));

import { displayActions, MoltentermNotification } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";

function waiting(extra: Partial<MoltentermNotification>): MoltentermNotification {
    return {
        id: "n1",
        source: "agent",
        kind: "warning",
        title: "Codex is waiting for you",
        time: 1,
        updated: 1,
        read: true,
        workspaceid: "ws",
        ...extra,
    };
}

describe("Go to the terminal (FR-SHELL-055 AC4)", () => {
    beforeEach(() => {
        app.setMeta = vi.fn(async () => {});
        app.setActiveTab = vi.fn();
        app.switchWorkspace = vi.fn();
        app.focusNode = vi.fn();
    });

    it("focuses the terminal of the tab in front", async () => {
        const entry = waiting({ tabid: "tab1", blockid: "here" });
        await MoltentermNotifications.getInstance().runAction(entry, displayActions(entry)[0]);
        expect(app.focusNode).toHaveBeenCalledWith("node-here");
        expect(app.setActiveTab).not.toHaveBeenCalled();
    });

    it("asks the other tab to focus the terminal, then shows that tab", async () => {
        const entry = waiting({ tabid: "tab2", blockid: "there" });
        await MoltentermNotifications.getInstance().runAction(entry, displayActions(entry)[0]);
        expect(app.setMeta).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                oref: "tab:tab2",
                meta: { "molten:focusblock": { blockid: "there", ts: expect.any(Number) } },
            })
        );
        expect(app.setActiveTab).toHaveBeenCalledWith("tab2");
    });

    it("does the same across workspaces", async () => {
        const entry = waiting({ workspaceid: "other", tabid: "tab9", blockid: "far" });
        await MoltentermNotifications.getInstance().runAction(entry, displayActions(entry)[0]);
        expect(app.setMeta).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ oref: "tab:tab9", meta: { "molten:focusblock": expect.anything() } })
        );
        expect(app.switchWorkspace).toHaveBeenCalledWith("other");
    });
});
