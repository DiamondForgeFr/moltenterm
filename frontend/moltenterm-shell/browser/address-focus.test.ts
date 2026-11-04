// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AddressHold,
    forgetAddressFocus,
    type HoldTarget,
    requestAddressFocus,
    takeAddressFocus,
} from "./address-focus";

beforeEach(() => {
    forgetAddressFocus("p1");
    forgetAddressFocus("p2");
});

describe("the address field of a page panel opened from a chooser (#1742)", () => {
    it("is handed to the panel's view model when it already exists", () => {
        const wantAddressFocus = vi.fn();
        requestAddressFocus("p1", { wantAddressFocus });
        expect(wantAddressFocus).toHaveBeenCalledTimes(1);
        expect(takeAddressFocus("p1")).toBe(false);
    });

    it("waits for the view model to be made when it does not exist yet", () => {
        requestAddressFocus("p1", null);
        requestAddressFocus("p2", undefined);
        expect(takeAddressFocus("p1")).toBe(true);
        expect(takeAddressFocus("p2")).toBe(true);
    });

    it("is taken once, by the panel that asked", () => {
        requestAddressFocus("p1", null);
        expect(takeAddressFocus("p2")).toBe(false);
        expect(takeAddressFocus("p1")).toBe(true);
        expect(takeAddressFocus("p1")).toBe(false);
    });

    it("asks nothing for a panel without an id", () => {
        requestAddressFocus("", null);
        requestAddressFocus(null, null);
        expect(takeAddressFocus("")).toBe(false);
    });
});

// A window as the hold sees it: listeners by event type, fired by hand.
function fakeWindow() {
    const listeners = new Map<string, Set<(e: any) => void>>();
    const target: HoldTarget = {
        addEventListener: (type, fn) => {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
        },
        removeEventListener: (type, fn) => {
            listeners.get(type)?.delete(fn);
        },
    };
    const fire = (type: string, eventTarget?: unknown) => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
            fn({ target: eventTarget });
        }
    };
    const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
    return { target, fire, count };
}

const Page = { tagName: "WEBVIEW" };
const Field = { tagName: "INPUT" };

describe("the address field keeps the focus until the developer acts or an address loaded (#1742)", () => {
    it("holds from the start, and listens only while it holds", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        expect(hold.holds).toBe(false);
        expect(win.count()).toBe(0);
        hold.start();
        hold.start();
        expect(hold.holds).toBe(true);
        expect(win.count()).toBe(3);
        hold.stop();
        hold.stop();
        expect(hold.holds).toBe(false);
        expect(win.count()).toBe(0);
    });

    it("lets go when the developer presses a key anywhere, which includes typing", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.start();
        win.fire("keydown", Field);
        expect(hold.holds).toBe(false);
        expect(win.count()).toBe(0);
    });

    it("lets go when the developer clicks anywhere", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.start();
        win.fire("pointerdown", { tagName: "DIV" });
        expect(hold.holds).toBe(false);
    });

    it("lets go when a page takes the focus, and keeps it for the address field taking it itself", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.start();
        win.fire("focus", Field);
        win.fire("focus", null);
        expect(hold.holds).toBe(true);
        win.fire("focus", Page);
        expect(hold.holds).toBe(false);
    });

    it("lets go when an address finished loading, not for the start page or a blank page", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.start();
        for (const url of [undefined, null, "", "about:blank", "about:blank#moltenterm-start"]) {
            hold.noteLoadStopped(url);
            expect(hold.holds, String(url)).toBe(true);
        }
        hold.noteLoadStopped("file:///tmp/page.html");
        expect(hold.holds).toBe(false);
        expect(win.count()).toBe(0);
    });

    it("holds again when asked again, as a new panel does", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.start();
        win.fire("keydown");
        hold.start();
        expect(hold.holds).toBe(true);
        expect(win.count()).toBe(3);
    });

    it("never holds a panel nobody asked for, whatever loads or is pressed", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target);
        hold.noteLoadStopped("https://a.test");
        win.fire("keydown");
        expect(hold.holds).toBe(false);
    });

    it("recognises a page by its element", () => {
        const win = fakeWindow();
        const hold = new AddressHold(win.target, (t) => (t as { id?: string })?.id === "mine");
        hold.start();
        win.fire("focus", Page);
        expect(hold.holds).toBe(true);
        win.fire("focus", { id: "mine" });
        expect(hold.holds).toBe(false);
    });
});
