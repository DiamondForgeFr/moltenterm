// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
        expect(sections[0].shortcuts.map((s) => s.id)).toEqual(["split-right", "split-down", "split-chord"]);
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
