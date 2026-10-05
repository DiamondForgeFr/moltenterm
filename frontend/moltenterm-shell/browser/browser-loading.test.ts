// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    BrowserLoadModel,
    pickFavicon,
    reloadAction,
    ReloadIgnoringCache,
    ReloadNormal,
    ReloadStop,
    runReload,
} from "./browser-loading";

function fakeWebview(opts: { throws?: boolean } = {}) {
    const calls: string[] = [];
    const call = (name: string) => () => {
        if (opts.throws) {
            throw new Error("The WebView must be attached to the DOM and the dom-ready event emitted");
        }
        calls.push(name);
    };
    return { calls, stop: call("stop"), reload: call("reload"), reloadIgnoringCache: call("reloadIgnoringCache") };
}

describe("reloadAction", () => {
    it("stops a loading page, whatever the modifier", () => {
        expect(reloadAction(true, false)).toBe(ReloadStop);
        expect(reloadAction(true, true)).toBe(ReloadStop);
    });

    it("reloads an idle page, ignoring the cache when asked", () => {
        expect(reloadAction(false, false)).toBe(ReloadNormal);
        expect(reloadAction(false, true)).toBe(ReloadIgnoringCache);
    });
});

describe("runReload", () => {
    it("calls the webview method of the action", () => {
        const w = fakeWebview();
        expect(runReload(w, ReloadStop)).toBe(true);
        expect(runReload(w, ReloadNormal)).toBe(true);
        expect(runReload(w, ReloadIgnoringCache)).toBe(true);
        expect(w.calls).toEqual(["stop", "reload", "reloadIgnoringCache"]);
    });

    it("does nothing without a webview, and survives one not ready yet", () => {
        expect(runReload(null, ReloadNormal)).toBe(false);
        expect(runReload(fakeWebview({ throws: true }), ReloadNormal)).toBe(false);
    });
});

describe("pickFavicon", () => {
    it("takes the first web or data icon", () => {
        expect(pickFavicon(["chrome://x.png", "https://a.dev/f.ico", "https://a.dev/g.png"])).toBe(
            "https://a.dev/f.ico"
        );
        expect(pickFavicon(["data:image/png;base64,AA"])).toBe("data:image/png;base64,AA");
        expect(pickFavicon(["javascript:alert(1)"])).toBeUndefined();
        expect(pickFavicon(null)).toBeUndefined();
    });
});

describe("BrowserLoadModel", () => {
    it("tracks each tab's load on its own", () => {
        const m = new BrowserLoadModel();
        m.noteStart("a");
        expect(m.isLoading("a")).toBe(true);
        expect(m.isLoading("b")).toBe(false);
        m.noteStart("b");
        m.noteStop("a");
        expect(m.isLoading("a")).toBe(false);
        expect(m.isLoading("b")).toBe(true);
    });

    it("keeps the favicon across loads and forgets a closed tab", () => {
        const m = new BrowserLoadModel();
        m.noteFavicons("a", ["https://a.dev/f.ico"]);
        m.noteStart("a");
        m.noteFavicons("a", []);
        expect(m.get("a")).toEqual({ favicon: "https://a.dev/f.ico", loading: true });
        m.forget("a");
        expect(m.get("a")).toBeUndefined();
    });

    it("leaves the atom alone when nothing changes", () => {
        const m = new BrowserLoadModel();
        m.noteStop("a");
        const before = m.get("a");
        m.noteStop("a");
        expect(m.get("a")).toBe(before);
    });
});
