// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcut registry (FR-SHELL-042, DS-SHELL-067): every key MoltenTerm answers, with a label and a category, in one
// list read by the shortcuts sheet, the menus and the picker, so the same action shows the same keys everywhere. Keys
// use Wave's notation (keyutil.ts): "Cmd" is Command on macOS and Alt elsewhere. A unit test fails when a global
// binding of Wave's key model has no entry here.

import { isMacOS } from "@/util/platformutil";
import { t } from "../i18n/i18n";
import { hasKey } from "../i18n/i18n-core";
import { PinShortcutLabel } from "../view360/pin-text";

export type ShortcutCategory =
    | "Panels"
    | "Tabs"
    | "Workspaces"
    | "Terminal"
    | "Browser"
    | "Agents"
    | "Review"
    | "Palette and menus";

export const ShortcutCategories: ShortcutCategory[] = [
    "Panels",
    "Tabs",
    "Workspaces",
    "Terminal",
    "Browser",
    "Agents",
    "Review",
    "Palette and menus",
];

// global: the window's key model (keymodel.ts); app: the app menu; terminal, browser, review, palette: the focused view.
export type ShortcutScope = "global" | "app" | "terminal" | "browser" | "review" | "palette";

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
    // Keys that exist off macOS only (Ctrl+Shift+T as well as Cmd+Shift+T, #512).
    notMac?: boolean;
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
    // #677: Cmd-based keys collide (Cmd+Option+D hides the Dock, Ctrl+Cmd+D looks a word up, Cmd is Alt off macOS),
    // so the left and up splits take the Ctrl+Shift family of the panel keys.
    {
        id: "split-left",
        label: "Split left",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:d",
        keywords: ["add panel", "new panel", "pane"],
    },
    {
        id: "split-up",
        label: "Split up",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:e",
        keywords: ["add panel", "new panel", "pane"],
    },
    {
        id: "split-place",
        label: "Split… (choose the side)",
        category: "Panels",
        scope: "global",
        keys: "Shift:Cmd:s",
        keywords: ["add panel", "new panel", "pane", "split left", "split up", "placement"],
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
        id: "pin-panel",
        label: PinShortcutLabel,
        category: "Panels",
        scope: "global",
        keys: "Cmd:Shift:p",
        keywords: ["360", "carpet", "fixed zone", "pin beside", "unpin"],
    },
    // #825: "b" for balance, in the Ctrl+Shift family of the panel keys.
    {
        id: "equalize-panels",
        label: "Equalize panel widths",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:b",
        keywords: ["equalize", "even", "balance", "same width", "columns", "resize"],
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
    // 360 view (FR-SHELL-068): the carpet's previous / next panel; outside 360 view the key reaches the panel.
    {
        id: "carpet-previous",
        label: "Previous panel on the carpet (360 view)",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:PageUp",
        keywords: ["360", "carpet", "scroll", "radar"],
    },
    {
        id: "carpet-next",
        label: "Next panel on the carpet (360 view)",
        category: "Panels",
        scope: "global",
        keys: "Ctrl:Shift:PageDown",
        keywords: ["360", "carpet", "scroll", "radar"],
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
    {
        id: "reopen-closed",
        label: "Reopen the last closed pane or tab",
        category: "Tabs",
        scope: "global",
        keys: "Cmd:Shift:t",
        keywords: ["undo close", "restore", "closed tab", "closed panel"],
    },
    {
        id: "reopen-closed-ctrl",
        label: "Reopen the last closed pane or tab",
        category: "Tabs",
        scope: "global",
        keys: "Ctrl:Shift:t",
        keywords: ["undo close", "restore", "closed tab", "closed panel"],
        notMac: true,
    },
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
    // #1183: the workspace sidebar (FR-SHELL-079); an editor keeps the key for save.
    {
        id: "toggle-sidebar",
        label: "Hide or show the sidebar",
        category: "Workspaces",
        scope: "global",
        keys: "Cmd:s",
        keywords: ["sidebar", "hide", "show", "workspace"],
    },
    // #1187: the sidebar's top field (FR-SHELL-083); with the sidebar off ⌘L stays the page's address bar. ⌘L only:
    // ⌘K stays the terminal's clear (#1219).
    {
        id: "top-field",
        label: "Search, go to, open an address",
        category: "Workspaces",
        scope: "global",
        keys: "Cmd:l",
        keywords: ["top field", "search", "address", "url", "omnibox", "go to", "palette"],
    },
    {
        id: "workspace-number",
        label: "Switch to workspace by number",
        category: "Workspaces",
        scope: "app",
        keys: "Ctrl:Cmd:{1-9}",
    },
    // #1186: ⌥1…⌥9 from the sidebar's bottom bar (FR-SHELL-082); off macOS Alt+digit is the tab's.
    {
        id: "workspace-jump",
        label: "Jump to a workspace of the bottom bar",
        category: "Workspaces",
        scope: "global",
        keys: "Alt:{1-9}",
        bindings: digits((n) => [`Alt:c{Digit${n}}`]),
        keywords: ["workspace", "switch", "dots", "sidebar"],
        macOnly: true,
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
    // Review: in the Review tab's diff, on selected lines (FR-REV-003)
    {
        id: "review-ask",
        label: "Ask the AI about the selected lines",
        category: "Review",
        scope: "review",
        keys: "Alt:a",
        keywords: ["review", "question", "explain"],
    },
    {
        id: "review-comment",
        label: "Comment the selected lines",
        category: "Review",
        scope: "review",
        keys: "Alt:c",
        keywords: ["review", "comment"],
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
        id: "command-panel",
        label: "The focused panel's commands",
        category: "Palette and menus",
        scope: "global",
        keys: "Cmd:.",
        keywords: ["settings", "gear", "options", "panel menu", "command panel"],
    },
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

// The label and category the sheet shows, in the interface language: the registry keeps its English text as data
// (ids and categories are compared), translated where shown.
export function shortcutDisplayLabel(s: Shortcut): string {
    const key = `shortcuts.items.${s.id}`;
    return hasKey(key) ? t(key) : s.label;
}

export function shortcutCategoryLabel(category: ShortcutCategory): string {
    const key = `shortcuts.categories.${category.toLowerCase().replace(/[^a-z]+/g, "")}`;
    return hasKey(key) ? t(key) : category;
}

export function findShortcut(id: string): Shortcut {
    return Shortcuts.find((s) => s.id === id);
}

// The key model's bindings an entry covers: its own keys, the alternatives, or the digit family it names.
export function shortcutBindings(s: Shortcut): string[] {
    return s.bindings ?? [s.keys, ...(s.alt ?? [])];
}

// Shortcuts that apply on this platform.
export function platformShortcuts(mac = isMacOS()): Shortcut[] {
    return Shortcuts.filter((s) => (mac ? !s.notMac : !s.macOnly));
}

// Wave's modifier order in a key description does not matter ("Shift:Cmd:d" is "Cmd:Shift:d"): compare them sorted.
export function normalizeKeys(keys: string): string {
    const parts = (keys ?? "").split(":");
    const key = parts.pop();
    return [...parts.sort(), key].join(":");
}
