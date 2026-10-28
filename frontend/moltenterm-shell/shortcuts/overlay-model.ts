// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the shortcut overlay shows for a screen (FR-SHELL-090, DS-SHELL-129): caps next to the controls that declare a
// shortcut (data-mt-shortcut), a card on the focused panel with its keys and the keys of its type, a calm card on the
// panel under the pointer, and the sidebar's keys in the window's corner while it is hidden. Pure: the screen is read
// elsewhere (overlay-screen.ts), so the choice is unit tested.

import { t } from "../i18n/i18n";
import { keyCaps } from "./format";
import { findShortcut, Shortcut, shortcutDisplayLabel } from "./registry";

export const ShortcutAttr = "data-mt-shortcut";
// One digit of a family ("{1-9}"): the dot of the third workspace carries 3.
export const ShortcutDigitAttr = "data-mt-shortcut-n";

// Each cap starts 20 ms after the previous one; the last starts by 260 ms, so with the 120 ms entrance everything is
// in place within 400 ms (NFR-SHELL-040).
export const OverlayStaggerMs = 20;
export const OverlayEnterMs = 120;
export const OverlayLastStartMs = 260;

export const TerminalView = "term";
export const WebViews = ["web", "molten-browser"];
export const ReviewView = "molten-review";

// Entries that exist on one platform only, and their counterpart on the other.
const PlatformVariants: Record<string, string> = {
    "new-view-favorite": "new-view-favorite-other",
    "reopen-closed": "reopen-closed-ctrl",
};

export type OverlayRect = { left: number; top: number; width: number; height: number };

export type OverlayAnchor = { id: string; n?: number; rect: OverlayRect };

export type OverlayPanel = { blockId: string; view: string; rect: OverlayRect; num?: number };

export type OverlayScreen = {
    mac: boolean;
    sidebarEnabled: boolean;
    sidebarHidden: boolean;
    view360: boolean;
    focused?: OverlayPanel;
    hovered?: OverlayPanel;
    anchors: OverlayAnchor[];
};

export type OverlayRow = { shortcutId: string; caps: string[]; label: string };

export type OverlayCapItem = { key: string; shortcutId: string; caps: string[]; label: string; rect: OverlayRect };

export type OverlayCardKind = "focused" | "hovered" | "sidebar";

export type OverlayCard = { key: string; kind: OverlayCardKind; rect: OverlayRect; title: string; rows: OverlayRow[] };

export type OverlayContent = { caps: OverlayCapItem[]; cards: OverlayCard[] };

function appliesOn(s: Shortcut, mac: boolean): boolean {
    return mac ? !s.notMac : !s.macOnly;
}

// The registry entry a control's id names on this platform, or null when the key does not exist here.
export function platformShortcut(id: string, mac: boolean): Shortcut {
    const s = findShortcut(id);
    if (s != null && appliesOn(s, mac)) {
        return s;
    }
    const other = PlatformVariants[id] ?? Object.keys(PlatformVariants).find((k) => PlatformVariants[k] === id);
    const alt = other == null ? null : findShortcut(other);
    return alt != null && appliesOn(alt, mac) ? alt : null;
}

// The caps of an entry; with n, one digit of its family ("⌥" "3" for the third workspace dot).
export function shortcutCaps(s: Shortcut, mac: boolean, n?: number): string[] {
    let keys = s.keys;
    if (n != null) {
        keys = keys.replace(/\{\d-\d\}$/, String(n));
    }
    return keyCaps(keys, mac);
}

function row(id: string, mac: boolean, labelKey?: string): OverlayRow {
    const s = platformShortcut(id, mac);
    if (s == null) {
        return null;
    }
    return { shortcutId: s.id, caps: shortcutCaps(s, mac), label: labelKey ? t(labelKey) : shortcutDisplayLabel(s) };
}

function rows(ids: string[], mac: boolean): OverlayRow[] {
    return ids.map((id) => row(id, mac)).filter((r) => r != null);
}

// The keys of the focused panel's type (its section of the card).
export function panelTypeShortcutIds(view: string, screen: OverlayScreen): string[] {
    if (view === TerminalView) {
        return ["term-clear", "search", "term-copy-plain", "term-copy", "term-paste"];
    }
    if (WebViews.includes(view)) {
        // ⌘L is the top field's while the sidebar is on; the page's address bar takes it only without the sidebar.
        const address = screen.sidebarEnabled ? [] : ["browser-address"];
        return ["browser-reload", "browser-hard-reload", ...address, "search"];
    }
    if (view === ReviewView) {
        return ["review-ask", "review-comment"];
    }
    return [];
}

export function focusedPanelShortcutIds(screen: OverlayScreen): string[] {
    const ids = ["split-right", "split-down", "split-left", "split-up", "split-place", "close-panel", "magnify"];
    if (screen.view360) {
        ids.push("pin-panel", "carpet-previous", "carpet-next");
    }
    ids.push("command-panel");
    return [...ids, ...panelTypeShortcutIds(screen.focused?.view, screen)];
}

export function panelTypeTitle(view: string): string {
    if (view === TerminalView) {
        return t("shortcuts.overlay.types.terminal");
    }
    if (WebViews.includes(view)) {
        return t("shortcuts.overlay.types.web");
    }
    return t("shortcuts.overlay.types.panel");
}

function focusNumberRow(panel: OverlayPanel, mac: boolean): OverlayRow {
    if (panel.num == null || panel.num < 1 || panel.num > 9) {
        return null;
    }
    const s = platformShortcut("focus-number", mac);
    if (s == null) {
        return null;
    }
    return { shortcutId: s.id, caps: shortcutCaps(s, mac, panel.num), label: t("shortcuts.overlay.focusThis") };
}

export function overlayContent(screen: OverlayScreen): OverlayContent {
    const mac = screen.mac;
    const caps: OverlayCapItem[] = [];
    const seen = new Set<string>();
    for (const anchor of screen.anchors) {
        const s = platformShortcut(anchor.id, mac);
        if (s == null) {
            continue;
        }
        const key = `${s.id}:${anchor.n ?? ""}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        caps.push({
            key,
            shortcutId: s.id,
            caps: shortcutCaps(s, mac, anchor.n),
            label: shortcutDisplayLabel(s),
            rect: anchor.rect,
        });
    }
    const cards: OverlayCard[] = [];
    // A hidden sidebar peeking under the pointer shows its own toggle: no corner card then.
    const toggleShown = screen.anchors.some((a) => a.id === "toggle-sidebar");
    if (screen.sidebarEnabled && screen.sidebarHidden && !toggleShown) {
        const sidebarRows = [row("toggle-sidebar", mac, "shortcuts.overlay.showSidebar"), row("top-field", mac)].filter(
            (r) => r != null
        );
        cards.push({
            key: "sidebar",
            kind: "sidebar",
            rect: { left: 0, top: 0, width: 0, height: 0 },
            title: t("shortcuts.overlay.sidebar"),
            rows: sidebarRows,
        });
    }
    if (screen.focused != null) {
        cards.push({
            key: `focused:${screen.focused.blockId}`,
            kind: "focused",
            rect: screen.focused.rect,
            title: panelTypeTitle(screen.focused.view),
            rows: rows(focusedPanelShortcutIds(screen), mac),
        });
    }
    if (screen.hovered != null && screen.hovered.blockId !== screen.focused?.blockId) {
        const focusRow = focusNumberRow(screen.hovered, mac);
        if (focusRow != null) {
            cards.push({
                key: `hovered:${screen.hovered.blockId}`,
                kind: "hovered",
                rect: screen.hovered.rect,
                title: panelTypeTitle(screen.hovered.view),
                rows: [focusRow],
            });
        }
    }
    return { caps, cards };
}

// The start delay of each of count items: 20 ms apart, compressed so the last starts by OverlayLastStartMs; 0 under
// reduced motion (no animation at all).
export function staggerDelays(count: number, reducedMotion: boolean): number[] {
    if (count <= 0) {
        return [];
    }
    if (reducedMotion) {
        return new Array(count).fill(0);
    }
    const step = count <= 1 ? 0 : Math.min(OverlayStaggerMs, OverlayLastStartMs / (count - 1));
    return Array.from({ length: count }, (_, i) => Math.round(i * step));
}
