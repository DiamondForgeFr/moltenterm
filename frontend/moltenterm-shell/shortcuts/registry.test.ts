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

    it("never gives two global entries the same keys", () => {
        const global = Shortcuts.filter((s) => s.scope === "global")
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(new Set(global).size).toBe(global.length);
    });

    it("leaves macOS-only entries out elsewhere", () => {
        expect(platformShortcuts(true).some((s) => s.id === "term-copy-plain")).toBe(true);
        expect(platformShortcuts(false).some((s) => s.id === "term-copy-plain")).toBe(false);
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
