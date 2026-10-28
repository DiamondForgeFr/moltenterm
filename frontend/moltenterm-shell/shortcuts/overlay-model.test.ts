// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the shortcut overlay shows for a screen (FR-SHELL-090, TC-SHELL-173).

import { describe, expect, it } from "vitest";
import { modifierLabel } from "./format";
import {
    OverlayAnchor,
    overlayContent,
    OverlayEnterMs,
    OverlayScreen,
    platformShortcut,
    staggerDelays,
} from "./overlay-model";

const Rect = { left: 10, top: 10, width: 100, height: 30 };
const PanelRect = { left: 300, top: 0, width: 800, height: 600 };

const SidebarAnchors: OverlayAnchor[] = [
    { id: "toggle-sidebar", rect: Rect },
    { id: "top-field", rect: Rect },
    { id: "new-tab", rect: Rect },
    { id: "workspace-jump", n: 1, rect: Rect },
    { id: "workspace-jump", n: 2, rect: Rect },
];

function screen(over: Partial<OverlayScreen>): OverlayScreen {
    return {
        mac: true,
        sidebarEnabled: true,
        sidebarHidden: false,
        view360: false,
        anchors: [],
        ...over,
    };
}

function focusedIds(s: OverlayScreen): string[] {
    return overlayContent(s)
        .cards.find((c) => c.kind === "focused")
        .rows.map((r) => r.shortcutId);
}

describe("shortcut overlay content (FR-SHELL-090)", () => {
    it("puts caps on the sidebar's controls while it is shown, with each workspace dot's own digit", () => {
        const content = overlayContent(screen({ anchors: SidebarAnchors }));
        expect(content.caps.map((c) => c.shortcutId)).toEqual([
            "toggle-sidebar",
            "top-field",
            "new-tab",
            "workspace-jump",
            "workspace-jump",
        ]);
        expect(content.caps.find((c) => c.key === "workspace-jump:2").caps).toEqual(["⌥", "2"]);
        expect(content.caps.find((c) => c.shortcutId === "toggle-sidebar").caps).toEqual(["⌘", "S"]);
        expect(content.cards.some((c) => c.kind === "sidebar")).toBe(false);
    });

    it("shows the sidebar's keys in the corner while it is hidden, and nothing of it while it is off", () => {
        const hidden = overlayContent(screen({ sidebarHidden: true }));
        expect(hidden.caps).toEqual([]);
        const card = hidden.cards.find((c) => c.kind === "sidebar");
        expect(card.rows.map((r) => r.shortcutId)).toEqual(["toggle-sidebar", "top-field"]);
        expect(card.rows[0].label).toBe("Show the sidebar");
        // Peeking, the sidebar shows its own toggle.
        const peek = overlayContent(screen({ sidebarHidden: true, anchors: SidebarAnchors }));
        expect(peek.cards.some((c) => c.kind === "sidebar")).toBe(false);
        const off = overlayContent(screen({ sidebarEnabled: false, sidebarHidden: true }));
        expect(off.cards).toEqual([]);
    });

    it("gives a focused terminal the panel keys then the terminal's, ⌘K clear included", () => {
        const ids = focusedIds(screen({ focused: { blockId: "t", view: "term", rect: PanelRect } }));
        expect(ids.slice(0, 4)).toEqual(["split-right", "split-down", "split-left", "split-up"]);
        expect(ids).toEqual(expect.arrayContaining(["close-panel", "magnify", "term-clear", "term-paste"]));
        expect(ids).not.toContain("browser-reload");
        expect(ids).not.toContain("carpet-next");
        const card = overlayContent(screen({ focused: { blockId: "t", view: "term", rect: PanelRect } })).cards[0];
        expect(card.title).toBe("Terminal");
        expect(card.rows.find((r) => r.shortcutId === "term-clear").caps).toEqual(["⌘", "K"]);
    });

    it("gives a focused web page ⌘R, and the address bar's ⌘L only without the sidebar", () => {
        const withSidebar = focusedIds(screen({ focused: { blockId: "w", view: "molten-browser", rect: PanelRect } }));
        expect(withSidebar).toEqual(expect.arrayContaining(["browser-reload", "browser-hard-reload"]));
        expect(withSidebar).not.toContain("browser-address");
        expect(withSidebar).not.toContain("term-clear");
        const noSidebar = focusedIds(
            screen({ sidebarEnabled: false, focused: { blockId: "w", view: "web", rect: PanelRect } })
        );
        expect(noSidebar).toContain("browser-address");
    });

    it("adds the carpet and pin keys in 360 view", () => {
        const ids = focusedIds(screen({ view360: true, focused: { blockId: "t", view: "term", rect: PanelRect } }));
        expect(ids).toEqual(expect.arrayContaining(["pin-panel", "carpet-previous", "carpet-next"]));
    });

    it("gives the panel under the pointer its focus key, and nothing when it is the focused one", () => {
        const focused = { blockId: "a", view: "term", rect: PanelRect, num: 1 };
        const hovered = { blockId: "b", view: "web", rect: PanelRect, num: 3 };
        const content = overlayContent(screen({ focused, hovered }));
        const card = content.cards.find((c) => c.kind === "hovered");
        expect(card.rows).toEqual([{ shortcutId: "focus-number", caps: ["⌃", "⇧", "3"], label: "Focus this panel" }]);
        const same = overlayContent(screen({ focused, hovered: { ...focused } }));
        expect(same.cards.filter((c) => c.kind === "hovered")).toEqual([]);
    });

    it("formats the keys for the platform and drops the keys a platform does not have", () => {
        const other = overlayContent(
            screen({ mac: false, anchors: SidebarAnchors, focused: { blockId: "t", view: "term", rect: PanelRect } })
        );
        expect(other.caps.find((c) => c.shortcutId === "toggle-sidebar").caps).toEqual(["Alt", "S"]);
        // ⌥1…⌥9 exist on macOS only.
        expect(other.caps.some((c) => c.shortcutId === "workspace-jump")).toBe(false);
        const rows = other.cards[0].rows;
        expect(rows.find((r) => r.shortcutId === "split-right").caps).toEqual(["Alt", "D"]);
        expect(rows.some((r) => r.shortcutId === "term-copy-plain")).toBe(false);
        // The chooser's favourites take the platform's own entry.
        expect(platformShortcut("new-view-favorite", true).id).toBe("new-view-favorite");
        expect(platformShortcut("new-view-favorite", false).id).toBe("new-view-favorite-other");
        const fav = overlayContent(screen({ mac: false, anchors: [{ id: "new-view-favorite", n: 2, rect: Rect }] }));
        expect(fav.caps[0].caps).toEqual(["Alt", "Shift", "2"]);
        expect(modifierLabel("Cmd", true)).toBe("⌘");
        expect(modifierLabel("Cmd", false)).toBe("Alt");
    });

    it("ignores an unknown id and a control shown twice", () => {
        const content = overlayContent(
            screen({
                anchors: [
                    { id: "nope", rect: Rect },
                    { id: "new-tab", rect: Rect },
                    { id: "new-tab", rect: Rect },
                ],
            })
        );
        expect(content.caps.map((c) => c.shortcutId)).toEqual(["new-tab"]);
    });
});

describe("shortcut overlay stagger (NFR-SHELL-040)", () => {
    it("starts each part 20 ms after the previous one and ends within 400 ms however many there are", () => {
        expect(staggerDelays(3, false)).toEqual([0, 20, 40]);
        for (const count of [1, 5, 14, 40, 200]) {
            const delays = staggerDelays(count, false);
            expect(delays).toHaveLength(count);
            expect(Math.max(...delays) + OverlayEnterMs).toBeLessThan(400);
            expect([...delays].sort((a, b) => a - b)).toEqual(delays);
        }
    });

    it("does not stagger under reduced motion", () => {
        expect(staggerDelays(30, true)).toEqual(new Array(30).fill(0));
        expect(staggerDelays(0, false)).toEqual([]);
    });
});
