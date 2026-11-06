// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2026: what the notification store writes when the developer acts on a notification, goes to where it comes from,
// clears it, or undoes the clearing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    setMeta: null as any,
    clientAtom: null as any,
    calls: [] as string[],
    gesture: null as any,
}));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    app.clientAtom = atom({ meta: {} });
    return { ClientModel: { getInstance: () => ({ clientAtom: app.clientAtom, clientId: "client" }) } };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws", tabids: ["tab1", "tab2"] }) },
        getApi: () => ({
            setActiveTab: (id: string) => app.calls.push(`tab:${id}`),
            switchWorkspace: (id: string) => app.calls.push(`workspace:${id}`),
        }),
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

import { globalStore } from "@/app/store/jotaiStore";
import {
    MoltentermNotification,
    NotificationAction,
    NotificationKeyPrefix,
    parseNotifications,
} from "./notifications-model";
import { MoltentermNotifications, registerNotificationGesture } from "./notifications-store";

const Prefix = NotificationKeyPrefix;
const model = MoltentermNotifications.getInstance();

const Open: NotificationAction = { id: "go", label: "Go", kind: "open", workspaceid: "ws", tabid: "tab2" };
const Allow: NotificationAction = { id: "allow", label: "Allow", kind: "gesture", gesture: "test:allow" };

function stored(id: string, over: Record<string, unknown> = {}) {
    return {
        source: "ci",
        kind: "info",
        title: `Title ${id}`,
        time: 100,
        updated: 100,
        read: false,
        workspaceid: "ws",
        tabid: "tab2",
        ...over,
    };
}

// What wavesrv does with an update: merges it into the client meta, key by key, a null deleting the key.
function applyMeta(update: Record<string, any>) {
    const meta = { ...(globalStore.get(app.clientAtom) as { meta: Record<string, any> }).meta };
    for (const [key, value] of Object.entries(update)) {
        if (value == null) {
            delete meta[key];
        } else {
            meta[key] = JSON.parse(JSON.stringify(value));
        }
    }
    globalStore.set(app.clientAtom, { meta });
}

function seed(entries: Record<string, Record<string, unknown>>) {
    globalStore.set(app.clientAtom, {
        meta: Object.fromEntries(Object.entries(entries).map(([id, value]) => [Prefix + id, value])),
    });
}

function byId(id: string): MoltentermNotification {
    return parseNotifications((globalStore.get(app.clientAtom) as { meta: Record<string, any> }).meta).find(
        (e) => e.id === id
    );
}

function writes(): Record<string, any>[] {
    return app.setMeta.mock.calls.map((call: any[]) => call[1].meta);
}

beforeEach(() => {
    app.calls = [];
    app.gesture = vi.fn(async () => ({ ok: true }));
    app.setMeta = vi.fn(async (_client: unknown, request: { meta: Record<string, any> }) => applyMeta(request.meta));
    registerNotificationGesture("test:allow", (args) => app.gesture(args));
    model.errorsAtom && globalStore.set(model.errorsAtom, {});
});

describe("a notification is settled when the developer acts on it (FR-BOSS-009, AC16; FR-MC-019, #2026)", () => {
    it("resolves and files it when a button's gesture went through", async () => {
        seed({ n1: stored("n1", { kind: "warning", actions: [Allow] }) });
        const done = await model.runAction(byId("n1"), Allow);
        expect(done).toBe(true);
        expect(byId("n1")).toMatchObject({ read: true, resolved: expect.any(Number), archived: expect.any(Number) });
    });

    it("leaves it listed, with the reason, when the gesture failed or threw", async () => {
        seed({ n1: stored("n1", { kind: "warning", actions: [Allow] }) });
        app.gesture = vi.fn(async () => ({ ok: false, error: "refused" }));
        expect(await model.runAction(byId("n1"), Allow)).toBe(false);
        expect(byId("n1").archived).toBeUndefined();
        expect(byId("n1").resolved).toBeUndefined();
        expect(globalStore.get(model.errorsAtom).n1).toContain("refused");

        app.gesture = vi.fn(async () => {
            throw new Error("boom");
        });
        expect(await model.runAction(byId("n1"), Allow)).toBe(false);
        expect(byId("n1").archived).toBeUndefined();
    });

    it("leaves it listed when the action is not available in this version", async () => {
        const unknown: NotificationAction = { id: "x", label: "X", kind: "gesture", gesture: "test:missing" };
        seed({ n1: stored("n1", { actions: [unknown] }) });
        expect(await model.runAction(byId("n1"), unknown)).toBe(false);
        expect(byId("n1").archived).toBeUndefined();
    });

    it("settles it before an action that only goes somewhere takes the developer there", async () => {
        seed({ n1: stored("n1", { actions: [Open] }) });
        app.setMeta = vi.fn(async (_c: unknown, request: { meta: Record<string, any> }) => {
            app.calls.push("write");
            applyMeta(request.meta);
        });
        await model.runAction(byId("n1"), Open);
        expect(byId("n1")).toMatchObject({ resolved: expect.any(Number), archived: expect.any(Number), read: true });
        expect(app.calls).toEqual(["write", "tab:tab2"]);
    });

    it("settles it when the developer takes it to where it comes from", async () => {
        seed({ n1: stored("n1") });
        await model.open(byId("n1"));
        expect(byId("n1")).toMatchObject({ resolved: expect.any(Number), archived: expect.any(Number) });
        expect(app.calls).toEqual(["tab:tab2"]);
    });

    it("settles, in the same write, the other open notifications of the situation a gesture closes", async () => {
        seed({
            n1: stored("n1", { key: "dl:1", actions: [Allow] }),
            n2: stored("n2", { key: "dl:1" }),
            n3: stored("n3", { key: "dl:2" }),
        });
        app.gesture = vi.fn(async () => ({ ok: true, resolve: true }));
        await model.runAction(byId("n1"), Allow);
        expect(app.setMeta).toHaveBeenCalledTimes(2);
        const last = writes()[1];
        expect(Object.keys(last).sort()).toEqual([Prefix + "n1", Prefix + "n2"]);
        expect(byId("n1").archived).toEqual(expect.any(Number));
        expect(byId("n2").resolved).toEqual(expect.any(Number));
        expect(byId("n3").resolved).toBeUndefined();
    });

    it("writes nothing more when a lasting action of an archived notification is used again", async () => {
        const reveal: NotificationAction = { ...Allow, id: "reveal", lasting: true };
        seed({ n1: stored("n1", { actions: [reveal], archived: 150, resolved: 150, read: true }) });
        await model.runAction(byId("n1"), reveal);
        expect(app.setMeta).not.toHaveBeenCalled();
    });

    it("keeps the first date of a notification that was resolved before it was filed", async () => {
        seed({ n1: stored("n1", { resolved: 150, actions: [Open] }) });
        await model.runAction(byId("n1"), Open);
        expect(byId("n1").resolved).toBe(150);
        expect(byId("n1").archived).toEqual(expect.any(Number));
    });
});

describe("a notification is cleared by hand, and the clearing is undone (FR-MC-019, #2026)", () => {
    it("files the notifications of the list and reads them", () => {
        seed({
            n1: stored("n1"),
            n2: stored("n2", { kind: "warning" }),
            n3: stored("n3", { archived: 120, read: true }),
        });
        model.clear(["n1", "n2"]);
        expect(byId("n1")).toMatchObject({ archived: expect.any(Number), read: true });
        expect(byId("n2")).toMatchObject({ archived: expect.any(Number), read: true });
        expect(byId("n3").archived).toBe(120);
    });

    it("gives back exactly what was cleared: unread, read, resolved", async () => {
        seed({
            n1: stored("n1"),
            n2: stored("n2", { read: true }),
            n3: stored("n3", { resolved: 130, read: true }),
        });
        const undo = model.clear(["n1", "n2", "n3"]);
        await undo();
        for (const id of ["n1", "n2", "n3"]) {
            expect(byId(id).archived, id).toBeUndefined();
        }
        expect(byId("n1").read).toBe(false);
        expect(byId("n2").read).toBe(true);
        expect(byId("n3").resolved).toBe(130);
        expect(byId("n1").resolved).toBeUndefined();
    });

    it("leaves alone what changed since: cleared again later, or already archived before", async () => {
        seed({ n1: stored("n1"), n2: stored("n2"), n3: stored("n3", { archived: 120, read: true }) });
        const undo = model.clear(["n1", "n2", "n3"]);
        applyMeta({ [Prefix + "n2"]: { ...stored("n2"), read: true, archived: Date.now() + 5000 } });
        await undo();
        expect(byId("n1").archived).toBeUndefined();
        expect(byId("n2").archived).toEqual(expect.any(Number));
        expect(byId("n3").archived).toBe(120);
    });

    it("does not bring back a notification the retention dropped meanwhile", async () => {
        seed({ n1: stored("n1") });
        const undo = model.clear(["n1"]);
        applyMeta({ [Prefix + "n1"]: null });
        await undo();
        expect(byId("n1")).toBeUndefined();
    });

    it("clears nothing it was not given", () => {
        seed({ n1: stored("n1"), n2: stored("n2") });
        model.clear(["n1"]);
        expect(byId("n2").archived).toBeUndefined();
    });
});
