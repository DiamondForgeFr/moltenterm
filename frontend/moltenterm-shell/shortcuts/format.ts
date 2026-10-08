// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Shortcut keys as people read them (DS-SHELL-067): macOS glyphs (⌃ ⌥ ⇧ ⌘), words elsewhere where Wave's "Cmd" is
// Alt; and as Electron accelerators, so the native menus show the same keys.

import { isMacOS } from "@/util/platformutil";
import { findShortcut, Shortcut } from "./registry";

const MacModifierOrder = ["Ctrl", "Option", "Alt", "Shift", "Cmd", "Meta"];
const OtherModifierOrder = ["Ctrl", "Cmd", "Alt", "Option", "Meta", "Shift"];

const MacModifierGlyphs: Record<string, string> = {
    Ctrl: "⌃",
    Option: "⌥",
    Alt: "⌥",
    Shift: "⇧",
    Cmd: "⌘",
    Meta: "⌘",
};

// Wave maps Cmd to Alt and Option to Meta off macOS (keyutil.ts parseKeyDescription).
const OtherModifierWords: Record<string, string> = {
    Ctrl: "Ctrl",
    Cmd: "Alt",
    Alt: "Alt",
    Option: "Meta",
    Meta: "Meta",
    Shift: "Shift",
};

const MacKeyGlyphs: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Enter: "↵",
    Escape: "esc",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Home: "Home",
    End: "End",
    Space: "Space",
};

const OtherKeyWords: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Enter: "Enter",
    Escape: "Esc",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Del",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Home: "Home",
    End: "End",
    Space: "Space",
};

const ElectronKeyNames: Record<string, string> = {
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    Enter: "Return",
    Escape: "Esc",
    PageUp: "PageUp",
    PageDown: "PageDown",
};

function splitKeys(keys: string): { mods: string[]; key: string } {
    const parts = (keys ?? "").split(":").filter((p) => p !== "");
    const key = parts.pop() ?? "";
    return { mods: parts, key };
}

// "c{Digit1}" is the key code form of Wave's notation; "{1-9}" the registry's digit family.
function keyLabel(key: string, mac: boolean): string {
    if (key === "{1-9}") {
        return "1–9";
    }
    const code = key.match(/^c\{(?:Digit|Numpad)(\d)\}$/);
    if (code) {
        return code[1];
    }
    const named = (mac ? MacKeyGlyphs : OtherKeyWords)[key];
    if (named) {
        return named;
    }
    return key.length === 1 ? key.toUpperCase() : key;
}

// The keys as separate caps, for <kbd> rendering: ["⇧", "⌘", "D"] on macOS, ["Alt", "Shift", "D"] elsewhere.
export function keyCaps(keys: string, mac = isMacOS()): string[] {
    const { mods, key } = splitKeys(keys);
    const order = mac ? MacModifierOrder : OtherModifierOrder;
    const sorted = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const modCaps = sorted.map((m) => (mac ? MacModifierGlyphs[m] : OtherModifierWords[m]) ?? m);
    return [...modCaps, keyLabel(key, mac)];
}

// "⇧⌘D" on macOS, "Alt+Shift+D" elsewhere.
export function formatKeys(keys: string, mac = isMacOS()): string {
    return keyCaps(keys, mac).join(mac ? "" : "+");
}

// The full shortcut of an entry: its keys, the chord's second step, the alternatives.
export function formatShortcut(s: Shortcut, mac = isMacOS()): string {
    let rtn = formatKeys(s.keys, mac);
    if (s.then?.length) {
        rtn += " then " + s.then.map((k) => keyLabel(k, mac)).join(" ");
    }
    return rtn;
}

export function formatShortcutById(id: string, mac = isMacOS()): string {
    const s = findShortcut(id);
    return s == null ? "" : formatShortcut(s, mac);
}

// An Electron accelerator for the native menus (display only, the key model handles the keys). Families and chords
// have none.
export function electronAccelerator(keys: string, mac = isMacOS()): string {
    const { mods, key } = splitKeys(keys);
    if (key === "" || key.includes("{")) {
        return "";
    }
    const modNames = mods.map((m) => {
        switch (m) {
            case "Cmd":
                return mac ? "Command" : "Alt";
            case "Ctrl":
                return "Control";
            case "Shift":
                return "Shift";
            case "Option":
                return mac ? "Option" : "Super";
            case "Alt":
                return mac ? "Option" : "Alt";
            case "Meta":
                return mac ? "Command" : "Super";
            default:
                return m;
        }
    });
    const keyName = ElectronKeyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    return [...modNames, keyName].join("+");
}

export function acceleratorById(id: string, mac = isMacOS()): string {
    const s = findShortcut(id);
    if (s == null || s.then?.length) {
        return "";
    }
    return electronAccelerator(s.keys, mac);
}
