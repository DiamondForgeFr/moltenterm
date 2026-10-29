// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the app menu's View and Help items do in the active view (FR-SHELL-113, AC-3).

import * as jotai from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    tabs: {} as Record<string, { meta?: Record<string, any> }>,
    shown: [] as string[],
    toasts: [] as { kind: string; title: string }[],
    pinned: new Set<string>(),
    pinOpened: [] as string[],
    panelOpened: [] as string[],
}));

vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    const jotai = await import("jotai");
    return { globalStore, atoms: { workspace: jotai.atom(null) }, getApi: () => null };
});
vi.mock("@/app/store/wos", () => ({
    makeORef: (type: string, id: string) => `${type}:${id}`,
    getObjectValue: (oref: string) => env.tabs[oref.slice("tab:".length)] ?? null,
    reloadWaveObject: async () => null,
}));
vi.mock("../opener-tab", () => ({ showTabFromHere: (id: string) => env.shown.push(id) }));
vi.mock("../toast-store", () => ({ showToast: (toast: any) => env.toasts.push(toast) }));
vi.mock("../sidebar/view-pins-store", () => ({
    ViewPins: {
        getInstance: () => ({
            openPinShowing: async (view: string) => {
                if (!env.pinned.has(view)) {
                    return false;
                }
                env.pinOpened.push(view);
                return true;
            },
        }),
    },
}));
vi.mock("../open-view", () => ({ openMoltentermView: async (view: string) => env.panelOpened.push(view) }));

import { atoms, globalStore } from "@/app/store/global";
import { runAppMenuCommand, runShortcutKey } from "./app-menu-commands";
import { AppMenuCommands, isAppMenuCommand, workspaceViewTabId } from "./app-menu-model";

function setWorkspace(tabids: string[]) {
    globalStore.set(atoms.workspace as jotai.PrimitiveAtom<Workspace>, { oid: "ws1", tabids } as Workspace);
}

beforeEach(() => {
    env.tabs = {};
    env.shown = [];
    env.toasts = [];
    env.pinned = new Set();
    env.pinOpened = [];
    env.panelOpened = [];
});

describe("items bound to a key run the key's handler", () => {
    it("New view, Close, Reopen, Next and Previous view, Shortcuts, Palette", async () => {
        const ran: string[] = [];
        const keys = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        for (const k of ["Cmd:t", "Cmd:Shift:w", "Cmd:Shift:t", "Cmd:]", "Cmd:[", "Cmd:/", "Cmd:Shift:k"]) {
            keys.set(k, () => {
                ran.push(k);
                return true;
            });
        }
        for (const command of [
            "newview",
            "closeview",
            "reopen",
            "nextview",
            "previousview",
            "shortcuts",
            "palette",
        ] as const) {
            await runAppMenuCommand(command, keys);
        }
        expect(ran).toEqual(["Cmd:t", "Cmd:Shift:w", "Cmd:Shift:t", "Cmd:]", "Cmd:[", "Cmd:/", "Cmd:Shift:k"]);
    });

    it("a key nobody bound runs nothing", () => {
        expect(runShortcutKey(new Map(), "new-tab")).toBe(false);
        expect(runShortcutKey(null, "no-such-shortcut")).toBe(false);
    });
});

describe("Project and Integration", () => {
    it("open the top row's view of the panel", async () => {
        env.pinned = new Set(["molten-project", "molten-reviews"]);
        await runAppMenuCommand("project");
        await runAppMenuCommand("integration");
        expect(env.pinOpened).toEqual(["molten-project", "molten-reviews"]);
        expect(env.panelOpened).toEqual([]);
    });

    it("open the panel when no view of the top row shows it", async () => {
        await runAppMenuCommand("project");
        await runAppMenuCommand("integration");
        expect(env.panelOpened).toEqual(["molten-project", "molten-reviews"]);
    });
});

describe("Scoping and Control room", () => {
    it("go to the workspace's view of that name, renamed or not", async () => {
        env.tabs = {
            t1: { meta: {} },
            t2: { meta: { "molten:viewnamekey": "workspaceViews.names.scoping" } },
            t3: { meta: { "molten:viewnamekey": "workspaceViews.names.pilotage" } },
        };
        setWorkspace(["t1", "t2", "t3"]);
        await runAppMenuCommand("scoping");
        await runAppMenuCommand("pilotage");
        expect(env.shown).toEqual(["t2", "t3"]);
        expect(env.toasts).toEqual([]);
    });

    it("say so when the workspace has no such view", async () => {
        env.tabs = { t1: { meta: {} } };
        setWorkspace(["t1"]);
        await runAppMenuCommand("pilotage");
        expect(env.shown).toEqual([]);
        expect(env.toasts).toEqual([{ kind: "info", title: "This workspace has no “Control room” view" }]);
    });
});

describe("app-menu-model", () => {
    it("knows its commands only", () => {
        for (const c of AppMenuCommands) {
            expect(isAppMenuCommand(c)).toBe(true);
        }
        expect(isAppMenuCommand("rm")).toBe(false);
        expect(isAppMenuCommand(null)).toBe(false);
    });

    it("finds the first view with the name key", () => {
        const tabs = [
            { id: "a", meta: { "molten:viewnamekey": "k" } },
            { id: "b", meta: { "molten:viewnamekey": "k" } },
            null,
        ];
        expect(workspaceViewTabId(tabs, "k")).toBe("a");
        expect(workspaceViewTabId(tabs, "other")).toBeNull();
        expect(workspaceViewTabId(tabs, "")).toBeNull();
    });
});
