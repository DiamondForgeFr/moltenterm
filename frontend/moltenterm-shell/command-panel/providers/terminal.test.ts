// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    meta: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    metaWrites: [] as Record<string, unknown>[],
    settingsWrites: [] as Record<string, unknown>[],
}));

vi.mock("@/app/store/global", () => {
    const settingsAtom = { key: "settings" };
    const fullConfigAtom = { key: "full" };
    return {
        atoms: { settingsAtom, fullConfigAtom },
        getBlockMetaKeyAtom: (_blockId: string, key: string) => ({ key: `meta:${key}` }),
        globalStore: {
            get: (a: { key: string }) => {
                if (a.key === "settings") return state.settings;
                if (a.key === "full") {
                    return {
                        termthemes: {
                            dracula: { "display:name": "Dracula", "display:order": 2, background: "#282a36" },
                            "default-dark": { "display:name": "Default Dark", "display:order": 1, background: "#000" },
                        },
                    };
                }
                return state.meta[a.key.slice(5)];
            },
        },
    };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_c: unknown, data: { meta: Record<string, unknown> }) => {
            state.metaWrites.push(data.meta);
        },
        SetConfigCommand: async (_c: unknown, data: Record<string, unknown>) => {
            state.settingsWrites.push(data);
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/view/term/termutil", () => ({ DefaultTermTheme: "default-dark" }));

import { activeScope, canReset, effectiveValue, resetItem, setItemValue } from "../panel-model";
import { PanelContext } from "../panel-types";
import { cursorValue, terminalSections, themeOptions } from "./terminal";

function ctx(waveItems: ContextMenuItem[] = []): PanelContext {
    return {
        blockId: "b1",
        view: "term",
        meta: {},
        viewModel: { viewType: "term", getSettingsMenuItems: () => waveItems } as any,
        capabilities: new Set(["terminal"]),
        agent: null,
        kindLabel: "terminals",
        panelName: "Terminal",
    };
}

beforeEach(() => {
    state.meta = {};
    state.settings = {};
    state.metaWrites = [];
    state.settingsWrites = [];
});

describe("Terminal provider (DS-SHELL-090, TC-SHELL-102)", () => {
    it("reorganises the terminal's options and moves developer items to Developer", () => {
        const click = vi.fn();
        const [terminal, developer] = terminalSections(
            ctx([
                { label: "Save session as…", click },
                {
                    label: "Advanced",
                    submenu: [
                        { label: "Force Restart Controller", click },
                        {
                            label: "Debug Connection",
                            submenu: [
                                { label: "Off", type: "checkbox", checked: true, click },
                                { label: "Info", type: "checkbox", checked: false, click },
                            ],
                        },
                    ],
                },
            ])
        );
        expect(terminal.items.map((i) => i.label)).toEqual([
            "Theme",
            "Font size",
            "Cursor",
            "Transparency",
            "Save session as…",
            "Clear output on restart",
        ]);
        expect(developer.items.map((i) => i.label)).toEqual(["Bracketed paste", "Force restart", "Debug connection"]);
        const save = terminal.items.find((i) => i.label === "Save session as…") as any;
        save.run();
        expect(click).toHaveBeenCalled();
    });

    it("writes the font size to this panel and the theme to all terminals, and resets only that scope", async () => {
        const [terminal] = terminalSections(ctx());
        const font = terminal.items.find((i) => i.id === "term:fontsize") as any;
        const theme = terminal.items.find((i) => i.id === "term:theme") as any;
        expect(effectiveValue(font)).toBe(12);
        await setItemValue(font, 15, "panel");
        expect(state.metaWrites).toEqual([{ "term:fontsize": 15 }]);
        await setItemValue(theme, "dracula", "kind");
        expect(state.settingsWrites).toEqual([{ "term:theme": "dracula" }]);

        state.meta["term:fontsize"] = 15;
        state.settings["term:theme"] = "dracula";
        expect(activeScope(font).scope).toBe("panel");
        expect(activeScope(theme).scope).toBe("kind");
        expect(canReset(font)).toBe(true);
        await resetItem(font);
        expect(state.metaWrites.at(-1)).toEqual({ "term:fontsize": null });
        expect(state.settingsWrites).toHaveLength(1);
    });

    it("counts a global value equal to the built-in default as unset", () => {
        state.settings["term:fontsize"] = 12;
        const [terminal] = terminalSections(ctx());
        const font = terminal.items.find((i) => i.id === "term:fontsize") as any;
        expect(canReset(font, "kind")).toBe(false);
    });

    it("lists themes in their display order with swatches, and reads the cursor as style and blink", () => {
        const options = themeOptions({
            b: { "display:name": "B", "display:order": 2, background: "#111" } as any,
            a: { "display:name": "A", "display:order": 1, background: "#222", foreground: "#eee" } as any,
        });
        expect(options.map((o) => [o.label, o.swatch])).toEqual([
            ["A", ["#222", "#eee"]],
            ["B", ["#111"]],
        ]);
        expect(cursorValue(null, null)).toBe("block:false");
        expect(cursorValue("bar", true)).toBe("bar:true");
    });
});
