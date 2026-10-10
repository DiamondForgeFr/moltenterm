import { describe, expect, it } from "vitest";
import {
    actionableMenuItem,
    DeveloperSection,
    layoutMenuItems,
    layoutMenuTree,
    menuItemRole,
    menuLabel,
    menuOpenedByKeyboard,
    menuPoint,
    visibleMenuItems,
} from "./menu-model";

const shown = (items: ContextMenuItem[]) =>
    items.map((i) => (i.type === "separator" ? "—" : i.type === "header" ? `# ${i.label}` : i.label));

describe("menu sections (FR-SHELL-054, DS-SHELL-095)", () => {
    const close: ContextMenuItem = { label: "Close", destructive: true };
    const menu: ContextMenuItem[] = [
        close,
        { type: "separator" },
        { label: "Copy" },
        { label: "Paste" },
        { type: "separator" },
        { type: "separator" },
        { label: "Open link", section: "Link" },
        { label: "Split right", section: "Panel" },
        { label: "Copy panel id", section: DeveloperSection },
        { label: "Hidden", visible: false, section: "Link" },
        { label: "Magnify", section: "Panel" },
        { label: "Copy link", section: "Link" },
        { type: "separator" },
    ];

    it("draws a heading per section, merges a section's items and keeps destructive items last", () => {
        expect(shown(layoutMenuItems(menu))).toEqual([
            "Copy",
            "Paste",
            "# Link",
            "Open link",
            "Copy link",
            "# Panel",
            "Split right",
            "Magnify",
            "—",
            "Close",
        ]);
    });

    it("shows the Developer section only while Option is held, before the destructive group", () => {
        const items = shown(layoutMenuItems(menu, { developer: true }));
        expect(items.slice(-4)).toEqual(["# Developer", "Copy panel id", "—", "Close"]);
    });

    it("never draws two separators in a row nor one at an end, and no heading for a lone section", () => {
        const items = layoutMenuItems([
            { type: "separator" },
            { label: "A" },
            { type: "separator" },
            { label: "Gone", visible: false },
            { type: "separator" },
            { label: "B" },
            { type: "separator" },
        ]);
        expect(shown(items)).toEqual(["A", "—", "B"]);
        expect(shown(layoutMenuItems([{ label: "Split right", section: "Panel" }]))).toEqual(["Split right"]);
        expect(layoutMenuItems([{ label: "Dev", section: DeveloperSection }])).toEqual([]);
    });

    it("keeps a legacy header as a section heading and lays submenus out for native menus", () => {
        const tree = layoutMenuTree([
            { type: "header", label: "Theme" },
            { label: "Dark" },
            { type: "separator" },
            { label: "More", submenu: [{ type: "separator" }, { label: "X" }, { type: "separator" }] },
        ]);
        expect(shown(tree)).toEqual(["# Theme", "Dark", "—", "More"]);
        expect(shown(tree[3].submenu)).toEqual(["X"]);
    });

    it("knows a keyboard opening from a pointer one", () => {
        expect(menuOpenedByKeyboard({ type: "contextmenu", detail: 0 }, true)).toBe(true);
        expect(menuOpenedByKeyboard({ type: "click", detail: 0 }, false)).toBe(true);
        expect(menuOpenedByKeyboard({ type: "click", detail: 1 }, false)).toBe(false);
        expect(menuOpenedByKeyboard({ type: "contextmenu", detail: 0 }, false)).toBe(false);
    });
});

describe("menu contract", () => {
    it("keeps state and visibility while excluding inert rows from navigation", () => {
        const items: ContextMenuItem[] = [
            { role: "copy" },
            { label: "Hidden", visible: false },
            { type: "header", label: "Section" },
            { type: "separator" },
            { label: "Disabled", enabled: false },
            { type: "radio", label: "Active", checked: true },
        ];
        const visible = visibleMenuItems(items);
        expect(visible.map(menuLabel)).toEqual(["Copy", "Section", "", "Disabled", "Active"]);
        expect(visible.map(actionableMenuItem)).toEqual([true, false, false, false, true]);
        expect(menuItemRole(visible[4])).toBe("menuitemradio");
        expect(visible[4].checked).toBe(true);
    });
    it("uses pointer CSS coordinates and a focused-element keyboard origin", () => {
        expect(menuPoint({ clientX: 0, clientY: 10 })).toEqual({ x: 0, y: 10 });
        expect(menuPoint({ target: { getBoundingClientRect: () => ({ left: 15, bottom: 40 }) } as any })).toEqual({
            x: 15,
            y: 40,
        });
    });
});
