// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcut registry (FR-SHELL-042, DS-SHELL-067): every key MoltenTerm answers, with a label and a category, in one
// list read by the shortcuts sheet, the menus and the picker, so the same action shows the same keys everywhere. Keys
// use Wave's notation (keyutil.ts): "Cmd" is Command on macOS and Alt elsewhere. A unit test fails when a global
// binding of Wave's key model has no entry here.

import { isMacOS } from "@/util/platformutil";

export type ShortcutCategory =
    | "Panels"
    | "Tabs"
    | "Workspaces"
    | "Terminal"
    | "Browser"
    | "Agents"
    | "Palette and menus";

export const ShortcutCategories: ShortcutCategory[] = [
    "Panels",
    "Tabs",
    "Workspaces",
    "Terminal",
    "Browser",
    "Agents",
    "Palette and menus",
];

// global: the window's key model (keymodel.ts); app: the app menu; terminal, browser, palette: the focused view.
export type ShortcutScope = "global" | "app" | "terminal" | "browser" | "palette";

export type Shortcut = {
    id: string;
    label: string;
    category: ShortcutCategory;
    scope: ShortcutScope;
    // The keys, in Wave's notation; "{1-9}" stands for a digit.
    keys: string;
    // Other keys that do the same, shown after "or".
    alt?: string[];
    // The second step of a chord ("Ctrl:Shift:s" then an arrow).
    then?: string[];
    // The key model's bindings this entry covers, when they differ from keys and alt (digit families).
    bindings?: string[];
    // Extra words the sheet's search matches.
    keywords?: string[];
    macOnly?: boolean;
};

export const ShortcutsSheetKey = "Cmd:/";
// On layouts where "/" needs Shift (AZERTY, QWERTZ), the same keys with Shift.
export const ShortcutsSheetAltKey = "Cmd:Shift:/";

function digits(make: (n: number) => string[]): string[] {
    const rtn: string[] = [];
    for (let n = 1; n <= 9; n++) {
        rtn.push(...make(n));
    }
    return rtn;
}

export const Shortcuts: Shortcut[] = [
    // Panels
    {
        id: "split-right",
        label: "Split right",
        category: "Panels",
        scope: "global",
        keys: "Cmd:d",
        keywords: ["add panel", "new panel", "pane"],
    },
    {
        id: "split-down",
        label: "Split down",
        category: "Panels",
        scope: "global",
        keys: "Shift:Cmd:d",
        keywords: ["add panel", "new panel", "pane"],
    },
    {
        id: "split-chord",
        label: "Split in a direction",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:s",
        then: ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"],
        keywords: ["split left", "split up", "chord"],
    },
    { id: "new-panel", label: "New terminal panel", category: "Panels", scope: "global", keys: "Cmd:n" },
    { id: "close-panel", label: "Close the panel", category: "Panels", scope: "global", keys: "Cmd:w" },
    {
        id: "magnify",
        label: "Magnify the panel",
        category: "Panels",
        scope: "global",
        keys: "Cmd:m",
        keywords: ["zoom", "maximize"],
    },
    {
        id: "replace-panel",
        label: "Replace the panel with the picker",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:x",
    },
    {
        id: "focus-direction",
        label: "Focus the panel in a direction",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:ArrowLeft",
        alt: ["Ctrl:Shift:ArrowUp", "Ctrl:Shift:ArrowRight", "Ctrl:Shift:ArrowDown"],
        keywords: ["navigate", "move focus"],
    },
    {
        id: "focus-direction-vim",
        label: "Focus the panel in a direction (Vim keys)",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:h",
        alt: ["Ctrl:Shift:j", "Ctrl:Shift:k", "Ctrl:Shift:l"],
        keywords: ["navigate", "move focus"],
    },
    {
        id: "focus-number",
        label: "Focus panel by number",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:{1-9}",
        bindings: digits((n) => [`Ctrl:Shift:c{Digit${n}}`, `Ctrl:Shift:c{Numpad${n}}`]),
    },
    { id: "refocus", label: "Focus the panel again", category: "Panels", scope: "global", keys: "Cmd:i" },
    {
        id: "connection",
        label: "Change the panel's connection",
        category: "Panels",
        scope: "global",
        keys: "Cmd:g",
        keywords: ["ssh", "remote"],
    },
    {
        id: "search",
        label: "Search in the panel",
        category: "Panels",
        scope: "global",
        keys: "Cmd:f",
        keywords: ["find"],
    },
    // Tabs
    { id: "new-tab", label: "New tab", category: "Tabs", scope: "global", keys: "Cmd:t" },
    { id: "close-tab", label: "Close the tab", category: "Tabs", scope: "global", keys: "Cmd:Shift:w" },
    { id: "next-tab", label: "Next tab", category: "Tabs", scope: "global", keys: "Cmd:]", alt: ["Shift:Cmd:]"] },
    {
        id: "previous-tab",
        label: "Previous tab",
        category: "Tabs",
        scope: "global",
        keys: "Cmd:[",
        alt: ["Shift:Cmd:["],
    },
    {
        id: "tab-number",
        label: "Go to tab by number",
        category: "Tabs",
        scope: "global",
        keys: "Cmd:{1-9}",
        bindings: digits((n) => [`Cmd:${n}`]),
    },
    { id: "rename-tab", label: "Rename the tab", category: "Tabs", scope: "global", keys: "F2" },
    // Workspaces
    {
        id: "workspace-number",
        label: "Switch to workspace by number",
        category: "Workspaces",
        scope: "app",
        keys: "Ctrl:Cmd:{1-9}",
    },
    // Terminal
    { id: "term-clear", label: "Clear the terminal", category: "Terminal", scope: "terminal", keys: "Cmd:k" },
    {
        id: "term-copy-plain",
        label: "Copy the plain selection",
        category: "Terminal",
        scope: "terminal",
        keys: "Cmd:Shift:c",
        macOnly: true,
    },
    { id: "term-copy", label: "Copy the selection", category: "Terminal", scope: "terminal", keys: "Ctrl:Shift:c" },
    { id: "term-paste", label: "Paste", category: "Terminal", scope: "terminal", keys: "Ctrl:Shift:v" },
    {
        id: "term-scroll",
        label: "Scroll a page up or down",
        category: "Terminal",
        scope: "terminal",
        keys: "Shift:PageUp",
        alt: ["Shift:PageDown"],
    },
    {
        id: "term-ends",
        label: "Scroll to the top or the bottom",
        category: "Terminal",
        scope: "terminal",
        keys: "Shift:Home",
        alt: ["Shift:End"],
    },
    {
        id: "multi-input",
        label: "Type in every terminal of the tab",
        category: "Terminal",
        scope: "global",
        keys: "Ctrl:Shift:i",
        keywords: ["multi-input", "broadcast"],
    },
    // Browser
    { id: "browser-new-tab", label: "New browser tab", category: "Browser", scope: "browser", keys: "Cmd:t" },
    { id: "browser-close-tab", label: "Close the browser tab", category: "Browser", scope: "browser", keys: "Cmd:w" },
    { id: "browser-reload", label: "Reload the page", category: "Browser", scope: "browser", keys: "Cmd:r" },
    {
        id: "browser-hard-reload",
        label: "Reload ignoring the cache",
        category: "Browser",
        scope: "browser",
        keys: "Cmd:Shift:r",
    },
    {
        id: "browser-address",
        label: "Go to the address bar",
        category: "Browser",
        scope: "browser",
        keys: "Cmd:l",
        keywords: ["url"],
    },
    // Agents
    {
        id: "companion",
        label: "Agent companion",
        category: "Agents",
        scope: "global",
        keys: "Cmd:Shift:j",
        keywords: ["companion"],
    },
    // Palette and menus
    { id: "palette", label: "Command palette", category: "Palette and menus", scope: "global", keys: "Cmd:Shift:k" },
    {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        category: "Palette and menus",
        scope: "global",
        keys: ShortcutsSheetKey,
        alt: [ShortcutsSheetAltKey],
        keywords: ["keys", "help", "cheat sheet"],
    },
    {
        id: "escape",
        label: "Close a dialog or the search",
        category: "Palette and menus",
        scope: "global",
        keys: "Escape",
    },
    {
        id: "palette-right",
        label: "Open the palette's entry to the right",
        category: "Palette and menus",
        scope: "palette",
        keys: "Tab",
    },
];

export function findShortcut(id: string): Shortcut {
    return Shortcuts.find((s) => s.id === id);
}

// The key model's bindings an entry covers: its own keys, the alternatives, or the digit family it names.
export function shortcutBindings(s: Shortcut): string[] {
    return s.bindings ?? [s.keys, ...(s.alt ?? [])];
}

// Shortcuts that apply on this platform.
export function platformShortcuts(mac = isMacOS()): Shortcut[] {
    return Shortcuts.filter((s) => mac || !s.macOnly);
}

// Wave's modifier order in a key description does not matter ("Shift:Cmd:d" is "Cmd:Shift:d"): compare them sorted.
export function normalizeKeys(keys: string): string {
    const parts = (keys ?? "").split(":");
    const key = parts.pop();
    return [...parts.sort(), key].join(":");
}
