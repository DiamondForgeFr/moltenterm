// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { services, api, storeAtoms } = vi.hoisted(() => ({
    services: {
        GetWorkspace: vi.fn(async (_id: string): Promise<Workspace> => null),
        UpdateWorkspace: vi.fn(async (..._args: unknown[]) => {}),
    },
    api: { menuCallback: null as () => void },
    storeAtoms: {} as { workspace?: any; staticTabId?: any },
}));

vi.mock("@/app/store/services", () => ({ WorkspaceService: services }));
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return { getWaveObjectAtom: () => atom(null), makeORef: (otype: string, oid: string) => `${otype}:${oid}` };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    storeAtoms.workspace = atom(null);
    storeAtoms.staticTabId = atom("tab-1");
    return {
        atoms: storeAtoms,
        getApi: () => ({
            onMoltentermEditWorkspace: (callback: () => void) => {
                api.menuCallback = callback;
            },
        }),
    };
});

import {
    handOverWorkspaceEdit,
    listenWorkspaceMenu,
    openCurrentWorkspaceEditor,
    openWorkspaceEditor,
    pickUpWorkspaceEdit,
    recordSwitchClick,
    takeSwitchClick,
    WorkspaceEditModel,
} from "./workspace-edit";
import { WorkspaceEditIntentKey, WorkspaceSwitchClickKey } from "./workspace-edit-model";

const saved: Workspace = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF", activetabid: "tab-1" } as any;
const unsaved: Workspace = { oid: "w2", name: "", icon: "", color: "", activetabid: "tab-1" } as any;

function fakeStorage() {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k: string) => (map.has(k) ? map.get(k) : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
    };
}

let storage: ReturnType<typeof fakeStorage>;

function request() {
    return globalStore.get(WorkspaceEditModel.getInstance().requestAtom);
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

beforeEach(() => {
    WorkspaceEditModel.resetInstance();
    storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    services.GetWorkspace.mockReset();
    services.UpdateWorkspace.mockReset();
    services.GetWorkspace.mockImplementation(async (id: string) => ({ w1: saved, w2: unsaved })[id] ?? null);
    globalStore.set(storeAtoms.workspace, saved);
    globalStore.set(storeAtoms.staticTabId, "tab-1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("one open request (DS-SHELL-035)", () => {
    it("opens a saved workspace as it is", async () => {
        expect(await WorkspaceEditModel.getInstance().open("w1", null)).toBe(true);
        expect(request()).toEqual({ workspaceId: "w1", opener: null });
        expect(services.UpdateWorkspace).not.toHaveBeenCalled();
    });

    it("saves an unsaved workspace with its default name and icon first (FR-SHELL-030-AC4)", async () => {
        await WorkspaceEditModel.getInstance().open("w2", null);
        expect(services.UpdateWorkspace).toHaveBeenCalledExactlyOnceWith("w2", "", "", "", true);
        expect(request().workspaceId).toBe("w2");
    });

    it("opens nothing for a missing workspace or id, never an error", async () => {
        expect(await WorkspaceEditModel.getInstance().open("gone", null)).toBe(false);
        expect(await WorkspaceEditModel.getInstance().open("", null)).toBe(false);
        expect(request()).toBeNull();
    });

    it("keeps the request when the same workspace is asked again", async () => {
        const opener = { isConnected: true, focus: vi.fn() } as any;
        await WorkspaceEditModel.getInstance().open("w1", opener);
        await WorkspaceEditModel.getInstance().open("w1", null);
        expect(request().opener).toBe(opener);
        expect(services.GetWorkspace).toHaveBeenCalledTimes(1);
    });

    it("gives the focus back to the opener on close (FR-SHELL-030-AC9)", async () => {
        const opener = { isConnected: true, focus: vi.fn() } as any;
        await WorkspaceEditModel.getInstance().open("w1", opener);
        vi.useFakeTimers();
        WorkspaceEditModel.getInstance().close();
        expect(request()).toBeNull();
        // Not while the sheet is still mounted: its focus trap would take the focus back.
        expect(opener.focus).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(opener.focus).toHaveBeenCalledOnce();
    });

    it("does not focus an opener that left the page", async () => {
        const opener = { isConnected: true, focus: vi.fn() } as any;
        await WorkspaceEditModel.getInstance().open("w1", opener);
        vi.useFakeTimers();
        WorkspaceEditModel.getInstance().close();
        opener.isConnected = false;
        vi.runAllTimers();
        expect(opener.focus).not.toHaveBeenCalled();
    });

    it("acts on the workspace the window shows from the palette and the app menu (FR-SHELL-030-AC3)", async () => {
        openCurrentWorkspaceEditor();
        await settle();
        expect(request().workspaceId).toBe("w1");
        WorkspaceEditModel.getInstance().close();

        listenWorkspaceMenu();
        globalStore.set(storeAtoms.workspace, unsaved);
        api.menuCallback();
        await settle();
        expect(services.UpdateWorkspace).toHaveBeenCalledWith("w2", "", "", "", true);
        expect(request().workspaceId).toBe("w2");
    });

    it("passes the given opener through openWorkspaceEditor", async () => {
        const opener = { isConnected: true, focus: vi.fn() } as any;
        openWorkspaceEditor("w1", opener);
        await settle();
        expect(request().opener).toBe(opener);
    });
});

describe("double-click across a workspace switch (FR-SHELL-030-AC2)", () => {
    it("treats the next click on the new workspace as the second click, once", () => {
        recordSwitchClick("w1");
        expect(takeSwitchClick("w2")).toBe(false);
        expect(takeSwitchClick("w1")).toBe(true);
        expect(takeSwitchClick("w1")).toBe(false);
    });

    it("forgets a switch click older than a double-click", () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        recordSwitchClick("w1");
        vi.setSystemTime(10_800);
        expect(takeSwitchClick("w1")).toBe(false);
    });

    it("opens the sheet in the tab view that shows the workspace, and only there", async () => {
        handOverWorkspaceEdit("w1");
        globalStore.set(storeAtoms.staticTabId, "tab-other");
        expect(pickUpWorkspaceEdit()).toBe(false);
        globalStore.set(storeAtoms.workspace, unsaved);
        globalStore.set(storeAtoms.staticTabId, "tab-1");
        expect(pickUpWorkspaceEdit()).toBe(false);
        expect(storage.map.has(WorkspaceEditIntentKey)).toBe(true);

        globalStore.set(storeAtoms.workspace, saved);
        expect(pickUpWorkspaceEdit()).toBe(true);
        expect(storage.map.has(WorkspaceEditIntentKey)).toBe(false);
        await settle();
        expect(request().workspaceId).toBe("w1");
    });

    it("ignores a stale hand-over", () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        handOverWorkspaceEdit("w1");
        vi.setSystemTime(20_000);
        expect(pickUpWorkspaceEdit()).toBe(false);
    });

    it("only switches when storage is unavailable", () => {
        vi.stubGlobal("window", {
            localStorage: {
                getItem: () => {
                    throw new Error("blocked");
                },
                setItem: () => {
                    throw new Error("blocked");
                },
                removeItem: () => {},
            },
        });
        expect(() => recordSwitchClick("w1")).not.toThrow();
        expect(takeSwitchClick("w1")).toBe(false);
        expect(pickUpWorkspaceEdit()).toBe(false);
        expect(storage.map.has(WorkspaceSwitchClickKey)).toBe(false);
    });
});
