// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

const h = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    tab: null as { oid: string; blockids: string[] },
    workspace: { oid: "ws1", tabids: ["t0", "t1"], meta: {} } as Record<string, unknown>,
    createTab: vi.fn(),
    closeTab: vi.fn(async () => true),
    replaceBlock: vi.fn(async () => "b2"),
    run: vi.fn(async () => {}),
    closeNode: vi.fn(async () => {}),
    mac: true,
}));

vi.mock("@/app/store/global", () => {
    const atoms = { fullConfigAtom: "fullConfig", workspace: "workspace", staticTabId: "staticTabId" };
    return {
        atoms,
        getApi: () => ({ createTab: h.createTab, closeTab: h.closeTab }),
        getSettingsKeyAtom: (key: string) => `setting:${key}`,
        replaceBlock: h.replaceBlock,
        WOS: { getWaveObjectAtom: () => "tab", makeORef: (t: string, id: string) => `${t}:${id}` },
        globalStore: {
            get: (a: string) => {
                if (a === "fullConfig") {
                    return { presets: DefaultAgents, widgets: DefaultWidgets };
                }
                if (a === "workspace") {
                    return h.workspace;
                }
                if (a === "staticTabId") {
                    return h.tab?.oid;
                }
                if (a === "tab") {
                    return h.tab;
                }
                return h.settings[a.replace(/^setting:/, "")];
            },
        },
    };
});
vi.mock("@/layout/index", () => ({
    getLayoutModelForStaticTab: () => ({
        getNodeByBlockId: (id: string) => ({ id: `node-${id}` }),
        closeNode: h.closeNode,
    }),
}));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => h.mac }));
vi.mock("../palette/palette-actions", () => ({ runPaletteEntry: h.run }));

import { dismissNewView, openFavorite, openInNewView, openNewView, registerNewViewKeys } from "./new-view";
import { ChooserBlockDef, NewViewRunMetaKey } from "./new-view-model";

async function settle() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    h.settings = {};
    h.tab = { oid: "t1", blockids: ["b1"] };
    h.workspace = { oid: "ws1", tabids: ["t0", "t1"], meta: {} };
    h.mac = true;
    vi.clearAllMocks();
});

describe("openNewView (FR-SHELL-089)", () => {
    it("opens the chooser when the setting asks", async () => {
        openNewView();
        await settle();
        expect(h.createTab).toHaveBeenCalledWith(ChooserBlockDef);
    });

    it("skips the chooser with a type to open directly (TC-SHELL-167)", async () => {
        h.settings["app:newviewopen"] = "panel:defwidget@terminal";
        openNewView();
        await settle();
        expect(h.createTab).toHaveBeenCalledWith({ meta: { view: "term", controller: "shell" } });
        h.settings["app:newviewopen"] = "action:sessions";
        openNewView();
        await settle();
        expect(h.run).toHaveBeenCalledWith({ kind: "sessions" }, { placement: "new", blockId: null });
    });
});

describe("direct shortcuts of the favourites (TC-SHELL-168)", () => {
    it("bind ⌥⌘1…⌥⌘4 on macOS and Alt+Shift+1…4 elsewhere, each to its favourite", async () => {
        const map = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerNewViewKeys(map);
        expect([...map.keys()]).toEqual([1, 2, 3, 4].map((n) => `Cmd:Alt:c{Digit${n}}`));
        h.mac = false;
        const other = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerNewViewKeys(other);
        expect([...other.keys()]).toEqual([1, 2, 3, 4].map((n) => `Cmd:Shift:c{Digit${n}}`));

        h.settings["app:newviewfavorites"] = ["panel:defwidget@web", "panel:defwidget@terminal", "agent:codex"];
        expect(map.get("Cmd:Alt:c{Digit1}")(null)).toBe(true);
        await settle();
        expect(h.createTab).toHaveBeenLastCalledWith({ meta: { view: "molten-browser" } });
        map.get("Cmd:Alt:c{Digit2}")(null);
        await settle();
        expect(h.createTab).toHaveBeenLastCalledWith({ meta: { view: "term", controller: "shell" } });
        map.get("Cmd:Alt:c{Digit3}")(null);
        await settle();
        expect((h.createTab.mock.lastCall[0] as BlockDef).meta[NewViewRunMetaKey as keyof MetaType]).toBe(
            "agent:codex"
        );
        expect(map.get("Cmd:Alt:c{Digit4}")(null)).toBe(false);
        expect(openFavorite(4)).toBe(false);
    });
});

describe("the chooser's choice and cancel (TC-SHELL-166)", () => {
    it("opens a panel in the view itself, and runs an action then drops the empty view", async () => {
        const terminal = {
            id: "panel:t",
            group: "panels",
            label: "Terminal",
            icon: "",
            run: { kind: "widget", blockdef: { meta: { view: "term" } } },
        } as const;
        await openInNewView(terminal as any, "b1");
        expect(h.run).toHaveBeenCalledWith(terminal.run, { placement: "replace", blockId: "b1" });
        const sessions = {
            id: "action:sessions",
            group: "actions",
            label: "Sessions",
            icon: "",
            run: { kind: "sessions" },
        } as const;
        await openInNewView(sessions as any, "b1");
        expect(h.run).toHaveBeenLastCalledWith(sessions.run, { placement: "new", blockId: null });
        expect(h.closeTab).toHaveBeenCalledWith("ws1", "t1", false);
    });

    it("closes the new view on Escape; split meanwhile only the pane goes; the only view keeps a terminal", async () => {
        await dismissNewView("b1");
        expect(h.closeTab).toHaveBeenCalledWith("ws1", "t1", false);
        h.tab = { oid: "t1", blockids: ["b0", "b1"] };
        await dismissNewView("b1");
        expect(h.closeNode).toHaveBeenCalledWith("node-b1");
        h.tab = { oid: "t1", blockids: ["b1"] };
        h.workspace = { oid: "ws1", tabids: ["t1"], meta: {} };
        await dismissNewView("b1");
        expect(h.replaceBlock).toHaveBeenCalledWith("b1", { meta: { view: "term", controller: "shell" } }, true);
        expect(h.closeTab).toHaveBeenCalledTimes(1);
    });
});
