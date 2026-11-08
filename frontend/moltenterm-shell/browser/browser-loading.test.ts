// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    BrowserLoadModel,
    pickFavicon,
    reloadAction,
    ReloadIgnoringCache,
    ReloadNormal,
    ReloadStop,
    runReload,
    tabFaviconSrc,
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

    it("never takes an icon on MoltenTerm's backend, whose requests carry the app's credentials (#1961)", () => {
        const backend = "http://127.0.0.1:52011";
        expect(
            pickFavicon(["http://127.0.0.1:52011/wave/stream-file?path=%2Fetc%2Fhosts", "https://a.dev/f.ico"], backend)
        ).toBe("https://a.dev/f.ico");
        expect(pickFavicon(["http://127.0.0.1:52011/x.png"], backend)).toBeUndefined();
        expect(pickFavicon(["http://127.0.0.1:3000/favicon.ico"], backend)).toBe("http://127.0.0.1:3000/favicon.ico");
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

    it("remembers the site of the page that declared the icon, and names it to be asked of main", () => {
        const m = new BrowserLoadModel();
        expect(m.noteFavicons("a", ["https://cdn.a.dev/f.ico"], "https://a.dev/docs/x?q=1")).toBe("https://a.dev");
        expect(m.get("a")).toEqual({ favicon: "https://cdn.a.dev/f.ico", site: "https://a.dev" });
        expect(m.noteFavicons("a", ["javascript:x"], "https://a.dev/")).toBeNull();
    });

    it("leaves the atom alone when nothing changes", () => {
        const m = new BrowserLoadModel();
        m.noteStop("a");
        const before = m.get("a");
        m.noteStop("a");
        expect(m.get("a")).toBe(before);
    });

    it("knows a page whose process is gone until it starts loading again (#1814)", () => {
        const m = new BrowserLoadModel();
        m.noteStart("a");
        m.noteCrash("a");
        expect(m.isCrashed("a")).toBe(true);
        expect(m.isLoading("a")).toBe(false);
        expect(m.isCrashed("b")).toBe(false);
        m.noteStart("a");
        expect(m.isCrashed("a")).toBe(false);
        expect(m.isLoading("a")).toBe(true);
    });
});

describe("tabFaviconSrc (#2045: the app page loads no image from a web address)", () => {
    const kept = { "https://a.dev": { url: "data:image/png;base64,KEPT" } };

    it("draws the icon main kept for the page's site, never the address the page declared", () => {
        const load = { favicon: "https://a.dev/f.ico", site: "https://a.dev" };
        expect(tabFaviconSrc(load, kept)).toBe("data:image/png;base64,KEPT");
        expect(tabFaviconSrc(load, {})).toBeNull();
        expect(tabFaviconSrc({ favicon: "https://b.dev/f.ico", site: "https://b.dev" }, kept)).toBeNull();
        expect(tabFaviconSrc({ favicon: "https://a.dev/f.ico" }, kept)).toBeNull();
    });

    it("draws an inline icon as the page declared it", () => {
        expect(tabFaviconSrc({ favicon: "data:image/png;base64,AA", site: "https://a.dev" }, kept)).toBe(
            "data:image/png;base64,AA"
        );
    });

    it("draws nothing for a page that declared no icon, even when its site has one kept", () => {
        expect(tabFaviconSrc({ site: "https://a.dev" }, kept)).toBeNull();
        expect(tabFaviconSrc(undefined, kept)).toBeNull();
    });

    it("never hands back a kept entry that is not an inline image", () => {
        expect(
            tabFaviconSrc({ favicon: "https://a.dev/f.ico", site: "https://a.dev" }, {
                "https://a.dev": { url: "https://a.dev/f.ico" },
            })
        ).toBeNull();
    });
});
