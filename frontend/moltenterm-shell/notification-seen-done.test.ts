// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1938: what To handle's buttons write for a notification that only takes the developer somewhere. "Go to" reads it
// (the row is then seen and the badge stops counting it), "Done" resolves it (the row leaves).

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ setMeta: null as any, meta: {} as Record<string, any> }));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    const clientAtom = atom(() => ({ meta: app.meta }));
    return { ClientModel: { getInstance: () => ({ clientAtom, clientId: "client" }) } };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws", tabids: ["tab1"] }) },
        getApi: () => ({ setActiveTab: vi.fn(), switchWorkspace: vi.fn() }),
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
    getLayoutModelForStaticTab: () => ({ getNodeByBlockId: () => null, focusNode: vi.fn() }),
}));
vi.mock("./hidden-panel", () => ({ showPanel: vi.fn() }));
vi.mock("./open-view", () => ({ openMoltentermView: vi.fn() }));
vi.mock("./project/project-model", () => ({ checkProjectRoute: () => false, checkProjectSource: () => false }));
vi.mock("./project/project-tab", () => ({ showProjectTab: vi.fn() }));

import { buildToHandle, toHandleBadge } from "./boss/boss-to-handle-model";
import { MoltentermNotification, NotificationKeyPrefix, parseNotifications } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";

const Typed = {
    key: "agenthandofftyped:b2",
    source: "agents",
    kind: "warning",
    title: "Typed in Chloé's prompt: press Enter in its terminal to start",
    time: 100,
    updated: 100,
    read: false,
    workspaceid: "ws",
    tabid: "tab1",
    blockid: "b2",
    actions: [{ id: "goto", label: "Go to Chloé", kind: "open", workspaceid: "ws", tabid: "tab1", blockid: "b2" }],
};

function entry(): MoltentermNotification {
    return MoltentermNotifications.getInstance().entries()[0];
}

// What the next reading of the client meta gives, once wavesrv merged the window's update.
function merged(): MoltentermNotification[] {
    const meta = { ...app.meta };
    for (const call of app.setMeta.mock.calls) {
        Object.assign(meta, call[1].meta);
    }
    return parseNotifications(meta);
}

function toHandle(notifications: MoltentermNotification[]) {
    return buildToHandle({
        states: { states: {}, versions: {} },
        notifications,
        answers: {},
        readied: {},
        sessions: [],
        parked: {},
    });
}

describe("To handle's Go to and Done on a typed prompt's notification (#1938)", () => {
    beforeEach(() => {
        app.meta = { [NotificationKeyPrefix + "t1"]: Typed };
        app.setMeta = vi.fn(async () => {});
    });

    it("counts it before anything is done", () => {
        const list = toHandle([entry()]);
        expect(list.items).toHaveLength(1);
        expect(toHandleBadge(list).count).toBe(1);
    });

    it("settles it on Go to (#2026): the row leaves and the badge stops counting it", async () => {
        const goTo = entry().actions[0];
        await MoltentermNotifications.getInstance().runAction(entry(), goTo);
        expect(app.setMeta).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                oref: "client:client",
                meta: {
                    [NotificationKeyPrefix + "t1"]: expect.objectContaining({
                        read: true,
                        resolved: expect.any(Number),
                        archived: expect.any(Number),
                    }),
                },
            })
        );
        const list = toHandle(merged());
        expect(list.items).toEqual([]);
        expect(toHandleBadge(list).count).toBe(0);
    });

    it("keeps a notification read by another door listed and seen until it is done", () => {
        const list = toHandle([{ ...entry(), read: true }]);
        expect(list.items.map((item) => [item.key, item.seen])).toEqual([["notif:t1", true]]);
        expect(toHandleBadge(list).count).toBe(0);
    });

    it("settles it on Done: the row leaves", async () => {
        await MoltentermNotifications.getInstance().handle([entry().id]);
        const written = app.setMeta.mock.calls[0][1].meta[NotificationKeyPrefix + "t1"];
        expect(written.resolved).toEqual(expect.any(Number));
        expect(written.archived).toEqual(expect.any(Number));
        expect(written.read).toBe(true);
        expect(toHandle(merged()).items).toEqual([]);
    });
});
