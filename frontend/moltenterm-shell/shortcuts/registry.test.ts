// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { acceleratorById, electronAccelerator, formatKeys, formatShortcutById, keyCaps } from "./format";
import {
    normalizeKeys,
    platformShortcuts,
    shortcutBindings,
    ShortcutCategories,
    Shortcuts,
    ShortcutsSheetAltKey,
    ShortcutsSheetKey,
} from "./registry";
import { filterShortcuts } from "./shortcuts-search";

const KeyModelSource = fs.readFileSync(path.resolve(__dirname, "../../app/store/keymodel.ts"), "utf8");

// The shell's own global keys, read from their modules' sources (importing them would start the app's stores).
function sourceConstant(file: string, name: string): string {
    const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
    const m = source.match(new RegExp(`export const ${name} = "([^"]+)"`));
    return m?.[1];
}

const CommandPaletteKey = sourceConstant("../palette/palette-keys.ts", "CommandPaletteKey");
const CompanionKey = sourceConstant("../companion/companion-open.ts", "CompanionKey");
const CommandPanelKey = sourceConstant("../command-panel/command-panel-keys.ts", "CommandPanelKey");
const PinKey = sourceConstant("../view360/view360-pin.tsx", "PinKey");

// The bindings registerGlobalKeys sets, read from Wave's key model: string literals, the digit loops expanded.
function keyModelBindings(): string[] {
    const start = KeyModelSource.indexOf("function registerGlobalKeys()");
    const end = KeyModelSource.indexOf("function registerBuilderGlobalKeys()");
    const body = KeyModelSource.slice(start, end);
    const rtn: string[] = [];
    for (const m of body.matchAll(/globalKeyMap\.set\(\s*([`"])([^`"]+)\1/g)) {
        const key = m[2];
        if (key.includes("${idx}")) {
            for (let n = 1; n <= 9; n++) {
                rtn.push(key.replace("${idx}", String(n)));
            }
        } else {
            rtn.push(key);
        }
    }
    return rtn;
}

// Wave AI's focus keys, never registered: MoltentermNoAI is always on (#25).
const NoAIKeys = new Set([
    "Alt:c{Digit0}",
    "Alt:c{Numpad0}",
    "Ctrl:Shift:c{Digit0}",
    "Ctrl:Shift:c{Numpad0}",
    "Cmd:Shift:a",
]);

describe("shortcut registry (TC-SHELL-086)", () => {
    it("has an entry for every global binding of Wave's key model and of the shell", () => {
        const registered = new Set(Shortcuts.flatMap(shortcutBindings).map(normalizeKeys));
        const bindings = [
            ...keyModelBindings().filter((k) => !NoAIKeys.has(k)),
            CommandPaletteKey,
            CompanionKey,
            CommandPanelKey,
            PinKey,
            ShortcutsSheetKey,
            ShortcutsSheetAltKey,
        ];
        expect(bindings.length).toBeGreaterThan(30);
        const missing = bindings.filter((k) => !registered.has(normalizeKeys(k)));
        expect(missing).toEqual([]);
    });

    it("keeps Wave's Cmd+D and Cmd+Shift+D as the splits", () => {
        expect(keyModelBindings()).toEqual(expect.arrayContaining(["Cmd:d", "Shift:Cmd:d"]));
        expect(Shortcuts.find((s) => s.id === "split-right").keys).toBe("Cmd:d");
        expect(Shortcuts.find((s) => s.id === "split-down").keys).toBe("Shift:Cmd:d");
    });

    it("binds split left, split up and the placement mode in the key model, on keys nothing else uses (#677)", () => {
        const ids = ["split-left", "split-up", "split-place"];
        const keys = ids.map((id) => normalizeKeys(Shortcuts.find((s) => s.id === id).keys));
        expect(keys).toEqual(["Ctrl:Shift:d", "Ctrl:Shift:e", "Cmd:Shift:s"].map(normalizeKeys));
        expect(keyModelBindings().map(normalizeKeys)).toEqual(expect.arrayContaining(keys));
        const others = Shortcuts.filter((s) => !ids.includes(s.id))
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(others.filter((k) => keys.includes(k))).toEqual([]);
        expect(formatShortcutById("split-left", true)).toBe("⌃⇧D");
        expect(formatShortcutById("split-up", false)).toBe("Ctrl+Shift+E");
    });

    it("binds Cmd+/ only to the shortcuts sheet", () => {
        const sheetKeys = new Set([ShortcutsSheetKey, ShortcutsSheetAltKey].map(normalizeKeys));
        const others = Shortcuts.filter((s) => s.id !== "shortcuts")
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(others.filter((k) => sheetKeys.has(k))).toEqual([]);
        expect(
            keyModelBindings()
                .map(normalizeKeys)
                .filter((k) => sheetKeys.has(k))
        ).toEqual([]);
    });

    it("gives every entry a unique id, a label and a known category", () => {
        const ids = Shortcuts.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const s of Shortcuts) {
            expect(s.label).not.toBe("");
            expect(ShortcutCategories).toContain(s.category);
        }
    });

    it.each([true, false])("never gives two global entries the same keys on one platform (macOS: %s)", (mac) => {
        const global = platformShortcuts(mac)
            .filter((s) => s.scope === "global")
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(new Set(global).size).toBe(global.length);
    });

    it("leaves macOS-only entries out elsewhere", () => {
        expect(platformShortcuts(true).some((s) => s.id === "term-copy-plain")).toBe(true);
        expect(platformShortcuts(false).some((s) => s.id === "term-copy-plain")).toBe(false);
    });
});

describe("⌘T is the new panel and ⌘N the new view (#1742, FR-SHELL-086, FR-SHELL-089)", () => {
    const entry = (id: string) => Shortcuts.find((s) => s.id === id);

    it("lists the keys of each, and the browser panel keeps no key of its own for a tab", () => {
        expect(entry("new-panel").keys).toBe("Cmd:t");
        expect(entry("new-tab").keys).toBe("Cmd:n");
        expect(entry("browser-new-tab")).toBeUndefined();
        const browser = Shortcuts.filter((s) => s.scope === "browser").flatMap(shortcutBindings);
        expect(browser.map(normalizeKeys)).not.toContain(normalizeKeys("Cmd:t"));
    });

    it("draws ⌘T and ⌘N on macOS, Alt+T and Alt+N where Wave's Cmd is Alt", () => {
        expect(formatShortcutById("new-panel", true)).toBe("⌘T");
        expect(formatShortcutById("new-tab", true)).toBe("⌘N");
        expect(formatShortcutById("new-panel", false)).toBe("Alt+T");
        expect(formatShortcutById("new-tab", false)).toBe("Alt+N");
    });

    it("binds each in the key model to what the registry says it does", () => {
        expect(keyModelBindings()).toEqual(expect.arrayContaining(["Cmd:t", "Cmd:n"]));
        expect(KeyModelSource).toMatch(/globalKeyMap\.set\("Cmd:t", \(\) => \{\s*handleCmdT\(\);/);
        expect(KeyModelSource).toMatch(/globalKeyMap\.set\("Cmd:n", \(\) => \{\s*openNewView\(\);/);
        expect(KeyModelSource).toMatch(/async function handleCmdT\(\) \{\s*await openNewPanel\(/);
    });

    it("finds both in the sheet by their names", () => {
        const ids = (query: string) =>
            filterShortcuts(platformShortcuts(true), query, true).flatMap((s) => s.shortcuts.map((x) => x.id));
        expect(ids("new panel")).toContain("new-panel");
        expect(ids("⌘T")).toContain("new-panel");
        expect(ids("⌘N")).toContain("new-tab");
    });
});

describe("shortcut formatting (FR-SHELL-042-AC8)", () => {
    it("draws macOS glyphs in the system's order", () => {
        expect(formatKeys("Cmd:d", true)).toBe("⌘D");
        expect(formatKeys("Shift:Cmd:d", true)).toBe("⇧⌘D");
        expect(formatKeys("Ctrl:Shift:ArrowLeft", true)).toBe("⌃⇧←");
        expect(formatKeys("Cmd:/", true)).toBe("⌘/");
        expect(formatKeys("Cmd:{1-9}", true)).toBe("⌘1–9");
        expect(formatKeys("Ctrl:Shift:c{Digit3}", true)).toBe("⌃⇧3");
    });

    it("reads Alt for Wave's Cmd on Windows and Linux", () => {
        expect(formatKeys("Cmd:d", false)).toBe("Alt+D");
        expect(formatKeys("Shift:Cmd:d", false)).toBe("Alt+Shift+D");
        expect(formatKeys("Cmd:/", false)).toBe("Alt+/");
        expect(keyCaps("Ctrl:Shift:s", false)).toEqual(["Ctrl", "Shift", "S"]);
    });

    it("names page and line keys by glyph on macOS and in the interface language elsewhere (#741)", () => {
        expect(formatKeys("Shift:PageUp", true)).toBe("⇧⇞");
        expect(formatKeys("Cmd:End", true)).toBe("⌘↘");
        expect(formatKeys("Shift:PageDown", false)).toBe("Shift+PgDn");
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(formatKeys("Shift:PageUp", false)).toBe("Shift+Pg préc");
            expect(formatKeys("Ctrl:Home", false)).toBe("Ctrl+Début");
            expect(formatKeys("Ctrl:Space", true)).toBe("⌃Espace");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });

    it("shows a chord with its second step", () => {
        expect(formatShortcutById("split-chord", true)).toBe("⌃⇧S then ← ↑ → ↓");
    });

    it("gives the native menus Electron accelerators", () => {
        expect(electronAccelerator("Cmd:d", true)).toBe("Command+D");
        expect(electronAccelerator("Shift:Cmd:d", false)).toBe("Shift+Alt+D");
        expect(acceleratorById("split-right", true)).toBe("Command+D");
        expect(acceleratorById("split-chord", true)).toBe("");
        expect(electronAccelerator("Cmd:{1-9}", true)).toBe("");
    });
});

describe("shortcuts sheet search (TC-SHELL-085)", () => {
    it("lists Cmd+D and Cmd+Shift+D under Panels for 'split'", () => {
        const sections = filterShortcuts(platformShortcuts(true), "split", true);
        expect(sections[0].category).toBe("Panels");
        expect(sections[0].shortcuts.map((s) => s.id)).toEqual([
            "split-right",
            "split-down",
            "split-left",
            "split-up",
            "split-place",
            "split-chord",
        ]);
    });

    it("matches the keys as shown and keeps the category order", () => {
        expect(filterShortcuts(platformShortcuts(false), "alt+d", false)[0].shortcuts.map((s) => s.id)).toContain(
            "split-right"
        );
        const all = filterShortcuts(platformShortcuts(true), "", true).map((s) => s.category);
        expect(all).toEqual(ShortcutCategories);
        expect(filterShortcuts(platformShortcuts(true), "zzzz", true)).toEqual([]);
    });
});

describe("reopen the last closed pane or tab (#512)", () => {
    it("takes Cmd+Shift+T, and Ctrl+Shift+T off macOS, which nothing else uses", () => {
        const reopen = new Set(["reopen-closed", "reopen-closed-ctrl"]);
        const keys = ["Cmd:Shift:t", "Ctrl:Shift:t"].map(normalizeKeys);
        const others = Shortcuts.filter((s) => !reopen.has(s.id))
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(others.filter((k) => keys.includes(k))).toEqual([]);
        expect(
            keyModelBindings()
                .map(normalizeKeys)
                .filter((k) => keys.includes(k))
        ).toEqual([]);
        expect(platformShortcuts(true).map((s) => s.id)).toContain("reopen-closed");
        expect(platformShortcuts(true).map((s) => s.id)).not.toContain("reopen-closed-ctrl");
        expect(platformShortcuts(false).map((s) => s.id)).toEqual(expect.arrayContaining([...reopen]));
    });
});

describe("the browser's reflexes: window = view, tab = panel (#1744, FR-SHELL-139)", () => {
    // The body of one globalKeyMap.set(...) in registerGlobalKeys.
    function handlerOf(key: string): string {
        const start = KeyModelSource.indexOf(`globalKeyMap.set("${key}"`);
        expect(start, key).toBeGreaterThan(-1);
        return KeyModelSource.slice(start, KeyModelSource.indexOf("\n    });", start));
    }

    it("keeps Cmd+1 to 9 on views and Ctrl+Shift+1 to 9 on panels", () => {
        const view = Shortcuts.find((s) => s.id === "tab-number");
        const panel = Shortcuts.find((s) => s.id === "focus-number");
        expect(view.keys).toBe("Cmd:{1-9}");
        expect(view.label).toBe("Go to view by number");
        expect(panel.keys).toBe("Ctrl:Shift:{1-9}");
        expect(KeyModelSource).toContain("switchTabAbs(idx)");
        expect(KeyModelSource).toContain("switchBlockByBlockNum(idx)");
    });

    it("asks the browser panel that holds the focus before Cmd+[ and Cmd+] switch views, and never for Cmd+Shift+[ ]", () => {
        for (const [key, direction] of [
            ["Cmd:]", 1],
            ["Cmd:[", -1],
        ] as const) {
            const body = handlerOf(key);
            expect(body, key).toContain(`windowHistoryKey(${direction})`);
            expect(body.indexOf("windowHistoryKey"), key).toBeLessThan(body.indexOf("switchTab("));
        }
        for (const key of ["Shift:Cmd:]", "Shift:Cmd:["]) {
            expect(handlerOf(key), key).not.toContain("windowHistoryKey");
        }
    });

    it("lists the page's back and forward in the Browser section beside the view keys in Tabs", () => {
        const tabs = Shortcuts.filter((s) => s.category === "Tabs").map((s) => s.id);
        expect(tabs).toEqual(expect.arrayContaining(["next-tab", "previous-tab", "tab-number", "reopen-closed"]));
        const history = (s: { category: string; id: string }) =>
            s.category === "Browser" && /^browser-(back|forward)/.test(s.id);
        const mac = platformShortcuts(true).filter(history);
        const other = platformShortcuts(false).filter(history);
        expect(mac.flatMap((s) => [s.keys, ...(s.alt ?? [])])).toEqual([
            "Cmd:[",
            "Cmd:ArrowLeft",
            "Cmd:]",
            "Cmd:ArrowRight",
        ]);
        expect(other.flatMap((s) => [s.keys, ...(s.alt ?? [])])).toEqual(["Alt:ArrowLeft", "Alt:ArrowRight"]);
    });

    it("shows the keys with the platform's glyphs", () => {
        expect(formatShortcutById("reopen-closed", true)).toBe("⇧⌘T");
        expect(formatShortcutById("reopen-closed-ctrl", false)).toBe("Ctrl+Shift+T");
        expect(formatShortcutById("browser-back", true)).toBe("⌘[");
        expect(formatShortcutById("browser-back-other", false)).toBe("Alt+←");
        expect(formatShortcutById("tab-number", true)).toBe("⌘1–9");
    });
});

describe("keep the view (#1652)", () => {
    it("takes ⌘⇧O on macOS and Ctrl+Shift+O elsewhere, which nothing else uses", () => {
        const keep = new Set(["keep-view", "keep-view-other"]);
        const keys = ["Cmd:Shift:o", "Ctrl:Shift:o"].map(normalizeKeys);
        const others = Shortcuts.filter((s) => !keep.has(s.id))
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(others.filter((k) => keys.includes(k))).toEqual([]);
        expect(
            keyModelBindings()
                .map(normalizeKeys)
                .filter((k) => keys.includes(k))
        ).toEqual([]);
        const mac = platformShortcuts(true).map((s) => s.id);
        const other = platformShortcuts(false).map((s) => s.id);
        expect(mac).toContain("keep-view");
        expect(mac).not.toContain("keep-view-other");
        expect(other).toContain("keep-view-other");
        expect(other).not.toContain("keep-view");
        expect(formatShortcutById("keep-view", true)).toBe("⇧⌘O");
        expect(formatShortcutById("keep-view-other", false)).toBe("Ctrl+Shift+O");
    });
});

// The physical keys a binding takes on one platform: Wave's Cmd is Command on macOS and Alt elsewhere, Option is Alt
// on macOS and Meta elsewhere; a digit by its code or by its key is the same key.
function physicalKeys(binding: string, mac: boolean): string[] {
    const parts = binding.split(":");
    const key = parts.pop();
    const mods = parts.map((m) => {
        switch (m) {
            case "Cmd":
                return mac ? "meta" : "alt";
            case "Option":
                return mac ? "alt" : "meta";
            case "Alt":
                return "alt";
            case "Meta":
                return "meta";
            default:
                return m.toLowerCase();
        }
    });
    const mod = [...new Set(mods)].sort().join("+");
    const digits = key.match(/^\{(\d)-(\d)\}$/);
    const keys = digits
        ? Array.from({ length: Number(digits[2]) - Number(digits[1]) + 1 }, (_, i) => String(Number(digits[1]) + i))
        : [key.replace(/^c\{Digit(\d)\}$/, "$1").toLowerCase()];
    return keys.map((k) => `${mod}+${k}`);
}

describe("the new view's favourite shortcuts (FR-SHELL-089, TC-SHELL-168)", () => {
    const ids = new Set(["new-view-favorite", "new-view-favorite-other"]);

    it.each([true, false])("take keys no other shortcut uses (macOS: %s)", (mac) => {
        const shortcuts = platformShortcuts(mac);
        const mine = shortcuts.filter((s) => ids.has(s.id));
        expect(mine).toHaveLength(1);
        const own = shortcutBindings(mine[0]).flatMap((b) => physicalKeys(b, mac));
        expect(own).toHaveLength(4);
        expect(new Set(own).size).toBe(4);
        const others = new Set(
            shortcuts
                .filter((s) => !ids.has(s.id))
                .flatMap((s) => shortcutBindings(s).flatMap((b) => physicalKeys(b, mac)))
        );
        expect(own.filter((k) => others.has(k))).toEqual([]);
        // ⌘K clears the terminal, ⌘L is the top field, ⌥1…⌥9 switch workspaces.
        for (const taken of ["Cmd:k", "Cmd:l", "Alt:c{Digit1}", "Alt:c{Digit4}"]) {
            expect(own).not.toContain(physicalKeys(taken, mac)[0]);
        }
        const fromKeyModel = new Set(keyModelBindings().flatMap((b) => physicalKeys(b, mac)));
        expect(own.filter((k) => fromKeyModel.has(k))).toEqual([]);
    });

    it("shows ⌥⌘1–4 on macOS and Alt+Shift+1–4 elsewhere", () => {
        expect(formatShortcutById("new-view-favorite", true)).toBe("⌥⌘1–4");
        expect(formatShortcutById("new-view-favorite-other", false)).toBe("Alt+Shift+1–4");
        expect(formatKeys("Cmd:Alt:c{Digit2}", true)).toBe("⌥⌘2");
    });
});

describe("the browser's Ctrl keys, the panel keys and find next (#1759, FR-SHELL-139 AC8 to AC11, TC-SHELL-254)", () => {
    const entry = (id: string) => Shortcuts.find((s) => s.id === id);
    const mine = new Set([
        ...["new-panel-ctrl", "close-panel-ctrl", "new-tab-ctrl", "close-tab-ctrl", "top-field-ctrl", "top-field-f6"],
        ...["previous-panel", "previous-panel-other", "next-panel", "next-panel-other"],
        ...["find-next", "find-previous", "find-next-ctrl", "find-previous-ctrl"],
    ]);

    it.each([true, false])("take keys no other window shortcut uses (macOS: %s)", (mac) => {
        const shortcuts = platformShortcuts(mac).filter((s) => s.scope === "global");
        const own = shortcuts
            .filter((s) => mine.has(s.id))
            .flatMap((s) => shortcutBindings(s).flatMap((b) => physicalKeys(b, mac)));
        expect(own.length).toBeGreaterThan(0);
        expect(new Set(own).size).toBe(own.length);
        // A browser panel's own keys (scope "browser") win while its page has the focus and do the same thing.
        const others = new Set([
            ...shortcuts
                .filter((s) => !mine.has(s.id))
                .flatMap((s) => shortcutBindings(s).flatMap((b) => physicalKeys(b, mac))),
            ...keyModelBindings().flatMap((b) => physicalKeys(b, mac)),
        ]);
        expect(own.filter((k) => others.has(k))).toEqual([]);
    });

    it("lists the Ctrl twins off macOS only, each marked as bound outside a terminal or an editor", () => {
        const twins = ["new-panel-ctrl", "close-panel-ctrl", "new-tab-ctrl", "close-tab-ctrl", "top-field-ctrl"];
        for (const id of twins) {
            expect(entry(id).notMac, id).toBe(true);
            expect(entry(id).outsideTerminalOrEditor, id).toBe(true);
            expect(
                platformShortcuts(true).map((s) => s.id),
                id
            ).not.toContain(id);
            expect(
                platformShortcuts(false).map((s) => s.id),
                id
            ).toContain(id);
            expect(entry(id).label, id).toContain("outside a terminal or editor");
        }
        expect(twins.map((id) => entry(id).keys)).toEqual(["Ctrl:t", "Ctrl:w", "Ctrl:n", "Ctrl:Shift:w", "Ctrl:l"]);
    });

    it("keeps the Alt keys, which work in a terminal too, as the entries they were", () => {
        expect(entry("new-panel").keys).toBe("Cmd:t");
        expect(entry("new-tab").keys).toBe("Cmd:n");
        expect(entry("close-panel").keys).toBe("Cmd:w");
        expect(entry("close-tab").keys).toBe("Cmd:Shift:w");
        expect(entry("top-field").keys).toBe("Cmd:l");
        for (const id of ["new-panel", "new-tab", "close-panel", "close-tab", "top-field"]) {
            expect(entry(id).outsideTerminalOrEditor, id).toBeUndefined();
            expect(entry(id).notMac, id).toBeUndefined();
        }
    });

    it("gives the panels a browser's tab keys: ⌘⌥← ⌘⌥→ on macOS, Ctrl+PageUp and PageDown everywhere, in a terminal too", () => {
        expect(entry("previous-panel").keys).toBe("Cmd:Alt:ArrowLeft");
        expect(entry("next-panel").keys).toBe("Cmd:Alt:ArrowRight");
        expect(entry("previous-panel").alt).toEqual(["Ctrl:PageUp"]);
        expect(entry("next-panel").alt).toEqual(["Ctrl:PageDown"]);
        expect(entry("previous-panel-other").keys).toBe("Ctrl:PageUp");
        expect(entry("next-panel-other").keys).toBe("Ctrl:PageDown");
        for (const id of ["previous-panel", "next-panel", "previous-panel-other", "next-panel-other"]) {
            expect(entry(id).outsideTerminalOrEditor, id).toBeUndefined();
            expect(entry(id).category, id).toBe("Panels");
        }
        const macIds = platformShortcuts(true).map((s) => s.id);
        const otherIds = platformShortcuts(false).map((s) => s.id);
        expect(macIds).toEqual(expect.arrayContaining(["previous-panel", "next-panel"]));
        expect(macIds).not.toEqual(expect.arrayContaining(["previous-panel-other"]));
        expect(otherIds).toEqual(expect.arrayContaining(["previous-panel-other", "next-panel-other"]));
        expect(otherIds).not.toContain("previous-panel");
    });

    it("keeps the views' keys: ⌘⇧[ and ⌘⇧] still switch views and the carpet's keys stay", () => {
        expect(entry("next-tab").alt).toEqual(["Shift:Cmd:]"]);
        expect(entry("previous-tab").alt).toEqual(["Shift:Cmd:["]);
        expect(entry("carpet-previous").alt).toEqual(["Ctrl:Shift:PageUp"]);
        expect(entry("carpet-next").alt).toEqual(["Ctrl:Shift:PageDown"]);
    });

    it("shares ⌘G between the connection and find next, which has no binding of its own", () => {
        expect(entry("connection").keys).toBe("Cmd:g");
        expect(entry("find-next").keys).toBe("Cmd:g");
        expect(shortcutBindings(entry("find-next"))).toEqual([]);
        expect(entry("find-previous").keys).toBe("Shift:Cmd:g");
        expect(entry("find-next-ctrl").keys).toBe("Ctrl:g");
        expect(entry("find-previous-ctrl").keys).toBe("Ctrl:Shift:g");
        expect(platformShortcuts(false).map((s) => s.id)).not.toContain("find-next");
        expect(platformShortcuts(true).map((s) => s.id)).not.toContain("find-next-ctrl");
    });

    it("opens the top field with F6 on every platform, outside a terminal or an editor", () => {
        expect(entry("top-field-f6").keys).toBe("F6");
        expect(entry("top-field-ctrl").alt).toEqual(["F6"]);
        expect(platformShortcuts(true).map((s) => s.id)).toContain("top-field-f6");
        expect(platformShortcuts(false).map((s) => s.id)).toContain("top-field-ctrl");
    });

    it("draws the platform's glyphs and words", () => {
        expect(formatShortcutById("previous-panel", true)).toBe("⌥⌘←");
        expect(formatShortcutById("next-panel", true)).toBe("⌥⌘→");
        expect(formatKeys("Ctrl:PageUp", true)).toBe("⌃⇞");
        expect(formatShortcutById("previous-panel-other", false)).toBe("Ctrl+PgUp");
        expect(formatShortcutById("next-panel-other", false)).toBe("Ctrl+PgDn");
        expect(formatShortcutById("new-panel-ctrl", false)).toBe("Ctrl+T");
        expect(formatShortcutById("new-tab-ctrl", false)).toBe("Ctrl+N");
        expect(formatShortcutById("close-panel-ctrl", false)).toBe("Ctrl+W");
        expect(formatShortcutById("close-tab-ctrl", false)).toBe("Ctrl+Shift+W");
        expect(formatShortcutById("top-field-ctrl", false)).toBe("Ctrl+L");
        expect(formatShortcutById("top-field-f6", true)).toBe("F6");
        expect(formatShortcutById("find-next", true)).toBe("⌘G");
        expect(formatShortcutById("find-previous", true)).toBe("⇧⌘G");
        expect(formatShortcutById("find-next-ctrl", false)).toBe("Ctrl+G");
        expect(formatShortcutById("find-previous-ctrl", false)).toBe("Ctrl+Shift+G");
    });

    it("finds them in the sheet by their names", () => {
        const ids = (query: string, mac: boolean) =>
            filterShortcuts(platformShortcuts(mac), query, mac).flatMap((s) => s.shortcuts.map((x) => x.id));
        expect(ids("previous panel", true)).toContain("previous-panel");
        expect(ids("ctrl+pgdn", false)).toContain("next-panel-other");
        expect(ids("find next", true)).toContain("find-next");
        expect(ids("find next", false)).toContain("find-next-ctrl");
        expect(ids("ctrl+g", false)).toContain("find-next-ctrl");
        expect(ids("F6", true)).toContain("top-field-f6");
    });
});
