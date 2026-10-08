import { describe, expect, it } from "vitest";
import { contextMenuRole, ownedMenuGuest, supportedMenuImage } from "./moltenterm-contextmenu-policy";
describe("context menu action boundary", () => {
    it("allowlists edit roles without prototype methods", () => {
        for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"])
            expect(contextMenuRole(role)).toBe(role);
        for (const role of ["constructor", "__proto__", "toString", "executeJavaScript", "downloadURL", null, {}])
            expect(contextMenuRole(role)).toBeNull();
    });
    it("accepts only bounded supported image protocols", () => {
        expect(supportedMenuImage("https://local.test/image.png")).toBe(true);
        expect(supportedMenuImage("data:image/png;base64,AA==")).toBe(true);
        for (const url of [
            "file:///secret",
            "javascript:alert(1)",
            "data:text/html,secret",
            "blob:https://local.test/id",
            "data:image/png," + "a".repeat(8 * 1024 * 1024),
        ])
            expect(supportedMenuImage(url)).toBe(false);
    });
    it("rejects cross-window, destroyed and non-webview targets", () => {
        const guest = { isDestroyed: () => false, getType: () => "webview", hostWebContents: { id: 10 } };
        expect(ownedMenuGuest({ id: 10 }, guest)).toBe(true);
        expect(ownedMenuGuest({ id: 20 }, guest)).toBe(false);
        expect(ownedMenuGuest({ id: 10 }, { ...guest, getType: () => "window" })).toBe(false);
        expect(ownedMenuGuest({ id: 10 }, { ...guest, isDestroyed: () => true })).toBe(false);
    });
});
