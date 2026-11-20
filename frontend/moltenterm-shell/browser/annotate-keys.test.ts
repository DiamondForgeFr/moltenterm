// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The annotate shortcut collides with nothing (FR-BRW-017 AC16, #2327): ⌘⇧A, Ctrl+Shift+A elsewhere, a key of the
// browser panel, held back from its page, and absent from every global binding and from the inspector's keys.

import { setKeyUtilPlatform } from "@/util/keyutil";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatShortcutById } from "../shortcuts/format";
import {
    normalizeKeys,
    platformShortcuts,
    shortcutBindings,
    shortcutDisplayLabel,
    Shortcuts,
} from "../shortcuts/registry";
import { browserKeyAction, BrowserKeyAnnotate, BrowserKeyInspect, browserPageKeys } from "./browser-keys";

type Mods = { meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean };

function key(k: string, mods: Mods, mac: boolean): WaveKeyboardEvent {
    return {
        type: "keydown",
        key: k,
        code: "",
        shift: !!mods.shift,
        control: !!mods.control,
        alt: !!mods.alt,
        meta: !!mods.meta,
        cmd: mac ? !!mods.meta : !!mods.alt,
        option: mac ? !!mods.alt : !!mods.meta,
    } as WaveKeyboardEvent;
}

afterEach(() => setKeyUtilPlatform("darwin"));

describe("the annotate shortcut", () => {
    it("is ⌘⇧A on macOS and Ctrl+Shift+A elsewhere, in the registry's browser scope", () => {
        const mac = Shortcuts.find((s) => s.id === "browser-annotate");
        const other = Shortcuts.find((s) => s.id === "browser-annotate-other");
        expect([mac.scope, mac.keys, mac.macOnly]).toEqual(["browser", "Cmd:Shift:a", true]);
        expect([other.scope, other.keys, other.notMac]).toEqual(["browser", "Ctrl:Shift:a", true]);
        expect(formatShortcutById("browser-annotate", true)).toBe("⇧⌘A");
        expect(formatShortcutById("browser-annotate-other", false)).toBe("Ctrl+Shift+A");
        expect(shortcutDisplayLabel(mac)).toBe("Comment on the page");
    });

    it("is read as the annotate action by the panel's key table, on its own platform only", () => {
        setKeyUtilPlatform("darwin");
        expect(browserKeyAction(key("A", { meta: true, shift: true }, true), true)).toBe(BrowserKeyAnnotate);
        expect(browserKeyAction(key("a", { meta: true }, true), true)).toBeNull();
        expect(browserKeyAction(key("A", { control: true, shift: true }, true), true)).toBeNull();
        setKeyUtilPlatform("linux");
        expect(browserKeyAction(key("A", { control: true, shift: true }, false), false)).toBe(BrowserKeyAnnotate);
        expect(browserKeyAction(key("a", { control: true }, false), false)).toBeNull();
    });

    it("is held back from the page while it has the focus, as the other keys of the panel", () => {
        expect(browserPageKeys(true)).toContain("Cmd:Shift:a");
        expect(browserPageKeys(false)).toContain("Ctrl:Shift:a");
        expect(browserPageKeys(true)).not.toContain("Ctrl:Shift:a");
    });

    it.each([true, false])("is bound to no other registered shortcut, whatever its scope (macOS: %s)", (mac) => {
        const annotate = new Set(["browser-annotate", "browser-annotate-other"]);
        const mine = platformShortcuts(mac)
            .filter((s) => annotate.has(s.id))
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(mine).toHaveLength(1);
        const others = platformShortcuts(mac)
            .filter((s) => !annotate.has(s.id))
            .flatMap(shortcutBindings)
            .map(normalizeKeys);
        expect(others.filter((k) => mine.includes(k))).toEqual([]);
    });

    it("is not the inspector's key, and no other action of the panel's table uses it", () => {
        setKeyUtilPlatform("darwin");
        expect(browserKeyAction(key("i", { meta: true, alt: true }, true), true)).toBe(BrowserKeyInspect);
        for (const [mac, keys] of [
            [true, "Cmd:Shift:a"],
            [false, "Ctrl:Shift:a"],
        ] as const) {
            expect(browserPageKeys(mac).filter((k) => k === keys)).toHaveLength(1);
        }
    });

    // Wave binds ⌘⇧A to its AI panel, which MoltenTerm never ships (#25): the key reaches the page like any other.
    it("is free in the window's key model: Wave's binding of it is registered only when its AI panel is on", () => {
        const source = readFileSync(resolve(__dirname, "../../app/store/keymodel.ts"), "utf8");
        expect([...source.matchAll(/globalKeyMap\.set\(\s*"Cmd:Shift:a"/g)]).toHaveLength(1);
        expect(source).toMatch(/if \(!MoltentermNoAI\) \{\s*globalKeyMap\.set\(\s*"Cmd:Shift:a"/);
        const flag = readFileSync(resolve(__dirname, "../../util/moltenterm-noai.ts"), "utf8");
        expect(flag).toContain("export const MoltentermNoAI = true;");
    });
});
