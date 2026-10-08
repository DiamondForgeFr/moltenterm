import { describe, expect, it, vi } from "vitest";
import { guestEditMenu, guestMenuEvent } from "./guest-menu";
import { menuHasRoles } from "./menu-model";

describe("guest menu adapter", () => {
    it("converts guest CSS into owning host CSS at differing zooms", () => {
        const webview = { getBoundingClientRect: () => ({ left: 100, top: 200 }) } as HTMLElement;
        const event = guestMenuEvent(
            { guestId: 3, x: 900, y: 900, guestX: 30, guestY: 40, guestScale: 2 / 1.5 },
            webview
        );
        expect(event.clientX).toBe(140);
        expect(event.clientY).toBeCloseTo(253.333);
        expect((event as any).contextMenuGuestId).toBe(3);
        const native = guestMenuEvent({ guestId: 3, x: 400, y: 500 }, webview);
        expect([native.clientX, native.clientY]).toEqual([400, 500]);
    });
    it("captures role leases only for menus containing edit roles and keeps opaque image tokens", () => {
        const save = vi.fn();
        expect(menuHasRoles([{ label: "Split", click: vi.fn() }])).toBe(false);
        expect(menuHasRoles([{ label: "Edit", submenu: [{ role: "copy" }] }])).toBe(true);
        const menu = guestEditMenu({ guestId: 3, x: 0, y: 0, imageToken: "captured-image" }, save);
        expect(menuHasRoles(menu)).toBe(false);
        menu[0].click();
        expect(save).toHaveBeenCalledWith("captured-image");
        expect(
            guestEditMenu({ guestId: 3, x: 0, y: 0, editable: true }, save)
                .filter((item) => item.role)
                .map((item) => item.role)
        ).toEqual(["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]);
    });
});
