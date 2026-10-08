import { describe, expect, it } from "vitest";
import { actionableMenuItem, menuItemRole, menuLabel, menuPoint, visibleMenuItems } from "./menu-model";
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
