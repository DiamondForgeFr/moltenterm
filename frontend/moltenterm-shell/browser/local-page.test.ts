// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    besideBlockDef,
    BrowserActiveMetaKey,
    browserMeta,
    BrowserOpenKeyPrefix,
    BrowserTabsMetaKey,
    readBrowserState,
    readOpenRequests,
    typedBlockDef,
    updateTab,
} from "./browser-model";
import {
    allowedWhenNavigated,
    canRememberLocalPage,
    displayLocalText,
    isLocalPage,
    isRememberedLocalPage,
    LocalData,
    LocalFile,
    localPageOf,
    needsLocalAsk,
    withRememberedLocalPage,
} from "./local-page";

// The app page of a packaged build is a file; a scheme-less address a webview tag gets resolves against it.
const AppBase = "file:///Applications/App/resources/app.asar/dist/frontend/index.html";
const at = (url: string) => localPageOf(url, AppBase);

describe("which addresses are local or inline pages (FR-BRW-014, #1978)", () => {
    it("reads a file address as the path on this computer", () => {
        expect(at("file:///Users/dev/proj/coverage/index.html")).toEqual({
            kind: LocalFile,
            path: "/Users/dev/proj/coverage/index.html",
        });
        expect(at("file:///Users/dev/My%20Report/a%23b.html?x=1#top").path).toBe("/Users/dev/My Report/a#b.html");
        expect(at("file://localhost/tmp/a.html").path).toBe("/tmp/a.html");
    });

    it("keeps a drive letter and a network host readable", () => {
        expect(at("file:///C:/Users/dev/report.html").path).toBe("C:/Users/dev/report.html");
        expect(at("file://fileserver/share/report.html").path).toBe("//fileserver/share/report.html");
    });

    it("reads an address as the webview tag does: case, spaces, tabs and line breaks do not hide a scheme", () => {
        expect(at("  FILE:///tmp/a.html  ").kind).toBe(LocalFile);
        expect(at("da\nta:text/html,<b>x</b>").kind).toBe(LocalData);
        expect(at("DATA:text/html,hi").kind).toBe(LocalData);
        expect(at("fi\tle:///etc/hosts").path).toBe("/etc/hosts");
    });

    it("counts a scheme-less address as the page it resolves to for the app", () => {
        expect(at("../../../../../etc/hosts").kind).toBe(LocalFile);
        expect(at("/etc/hosts").path).toBe("/etc/hosts");
        expect(at("//host/share/x.html").path).toBe("//host/share/x.html");
        // In development the app page is a dev server: a relative address stays on it.
        expect(localPageOf("report.html", "http://localhost:5173/")).toBeNull();
    });

    it("never counts web, empty or in-engine pages", () => {
        for (const url of [
            "https://example.com/a.html",
            "http://localhost:3000/",
            "about:blank",
            "about:blank#moltenterm-start",
            "",
            "   ",
            null,
            undefined,
            "molten-material://abc/index.html",
        ]) {
            expect(at(url), String(url)).toBeNull();
            expect(isLocalPage(url, AppBase)).toBe(false);
        }
    });

    it("tells an inline page by its type, size and beginning", () => {
        const page = at("data:text/html,%3Ch1%3EHello%3C%2Fh1%3E");
        expect(page).toEqual({ kind: LocalData, mediaType: "text/html", start: "<h1>Hello</h1>", length: 24 });
        expect(at("data:,plain").mediaType).toBe("text/plain");
        expect(at("data:text/html;charset=utf-8,hi").mediaType).toBe("text/html");
    });

    it("decodes the beginning of a base64 page and survives a broken one", () => {
        const html = "<script>alert(1)</script>";
        const encoded = Buffer.from(html).toString("base64");
        expect(at(`data:text/html;base64,${encoded}`).start).toBe(html);
        expect(at("data:text/html;base64,@@@@").start).toBe("@@@@");
        expect(at("data:text/html;base64,").start).toBe("");
        expect(at("data:text/html").length).toBe(0);
    });

    it("bounds what an inline page shows", () => {
        const page = at("data:text/plain," + "a".repeat(5000));
        expect(page.start.length).toBeLessThanOrEqual(160);
        expect(page.length).toBe(5000);
    });
});

describe("how the question writes a path", () => {
    it("escapes control and direction-changing characters, so a path reads as what it is", () => {
        expect(displayLocalText("/tmp/a\u202Etxt.html")).toBe("/tmp/a\\u202etxt.html");
        expect(displayLocalText("/tmp/a\nb\u0000c")).toBe("/tmp/a\\u000ab\\u0000c");
        expect(displayLocalText("/tmp/\u2066x\u2069")).toBe("/tmp/\\u2066x\\u2069");
    });

    it("keeps both ends of a long path", () => {
        const long = "/Users/dev/" + "deep/".repeat(200) + "report.html";
        const shown = displayLocalText(long);
        expect(shown.length).toBeLessThan(320);
        expect(shown.startsWith("/Users/dev/")).toBe(true);
        expect(shown.endsWith("report.html")).toBe(true);
        expect(shown).toContain(" … ");
        expect(displayLocalText("/tmp/a.html")).toBe("/tmp/a.html");
    });
});

describe("when a tab holds its page and asks", () => {
    const file = "file:///Users/dev/proj/coverage/index.html";

    it("asks for a local page nobody allowed", () => {
        expect(needsLocalAsk({ url: file }, null, AppBase)).toBe(true);
        expect(needsLocalAsk({ url: "data:text/html,hi" }, {}, AppBase)).toBe(true);
        expect(needsLocalAsk({ url: "../x.html" }, {}, AppBase)).toBe(true);
    });

    it("does not ask for a web page, a handed-off entry or an allowed tab", () => {
        expect(needsLocalAsk({ url: "https://example.com" }, null, AppBase)).toBe(false);
        expect(needsLocalAsk({ url: file, engine: "chrome" }, null, AppBase)).toBe(false);
        expect(needsLocalAsk({ url: file, allowed: true }, null, AppBase)).toBe(false);
        expect(needsLocalAsk({ url: "data:text/html,hi", allowed: true }, null, AppBase)).toBe(false);
        expect(needsLocalAsk(null, null, AppBase)).toBe(false);
    });

    it("does not ask again for a file the user chose to always open, and only that file", () => {
        const remembered = withRememberedLocalPage(null, at(file));
        expect(needsLocalAsk({ url: file }, remembered, AppBase)).toBe(false);
        expect(needsLocalAsk({ url: file + "?run=2#/tests" }, remembered, AppBase)).toBe(false);
        expect(needsLocalAsk({ url: "file:///Users/dev/proj/coverage/other.html" }, remembered, AppBase)).toBe(true);
        expect(
            needsLocalAsk({ url: "file:///Users/dev/proj/coverage/index.html/../../secret.html" }, remembered, AppBase)
        ).toBe(true);
        expect(needsLocalAsk({ url: "file:///Users/dev/proj/Coverage/index.html" }, remembered, AppBase)).toBe(true);
    });

    it("never remembers an inline page, and ignores a damaged setting", () => {
        expect(canRememberLocalPage(at("data:text/html,hi"))).toBe(false);
        expect(canRememberLocalPage(at(file))).toBe(true);
        expect(withRememberedLocalPage({ "/a": "allow" }, at("data:text/html,hi"))).toEqual({ "/a": "allow" });
        const page = at("file:///tmp/a.html");
        for (const damaged of [null, undefined, "allow", 3, [], { "/tmp/a.html": "block" }, { "/tmp/a.html": true }]) {
            expect(isRememberedLocalPage(page, damaged as any), JSON.stringify(damaged)).toBe(false);
        }
        expect(isRememberedLocalPage(at("file:///__proto__"), {})).toBe(false);
        expect(isRememberedLocalPage(at("file:///constructor"), {})).toBe(false);
    });

    it("adds a file to what is remembered without touching the rest", () => {
        const next = withRememberedLocalPage(
            { "/tmp/a.html": "allow", "/tmp/b.html": 3 as any },
            at("file:///tmp/c.html")
        );
        expect(next).toEqual({ "/tmp/a.html": "allow", "/tmp/c.html": "allow" });
    });

    it("keeps a tab allowed when its mounted page navigates to a local page", () => {
        expect(allowedWhenNavigated({ url: "https://a.dev" }, "file:///tmp/a.html", AppBase)).toEqual({
            allowed: true,
        });
        expect(allowedWhenNavigated({ url: "https://a.dev" }, "https://b.dev", AppBase)).toEqual({});
        expect(allowedWhenNavigated({ url: file, allowed: true }, "file:///tmp/b.html", AppBase)).toEqual({});
    });
});

describe("what a panel saves about an allowed tab", () => {
    it("round-trips the allowance with the saved tabs", () => {
        const state = { tabs: [{ id: "a", url: "file:///tmp/a.html", allowed: true }], activeId: "a" };
        const meta = browserMeta(state);
        expect(meta[BrowserTabsMetaKey]).toEqual([{ id: "a", url: "file:///tmp/a.html", allowed: true }]);
        expect(readBrowserState(meta, "about:blank")).toEqual({
            tabs: [{ id: "a", url: "file:///tmp/a.html", title: undefined, allowed: true }],
            activeId: "a",
        });
    });

    it("saves nothing for a tab that was not allowed, and reads only an exact true", () => {
        const meta = browserMeta({ tabs: [{ id: "a", url: "file:///tmp/a.html" }], activeId: "a" });
        expect(meta[BrowserTabsMetaKey][0]).not.toHaveProperty("allowed");
        for (const allowed of ["true", 1, "yes", {}, null]) {
            const read = readBrowserState(
                { [BrowserTabsMetaKey]: [{ id: "a", url: "file:///tmp/a.html", allowed }] },
                "about:blank"
            );
            expect(read.tabs[0].allowed, JSON.stringify(allowed)).toBeUndefined();
        }
    });

    it("reads a block's own url as a tab nobody allowed", () => {
        const state = readBrowserState({ view: "molten-browser", url: "file:///tmp/a.html" }, "about:blank");
        expect(state.tabs[0].allowed).toBeUndefined();
        expect(needsLocalAsk(state.tabs[0], null, AppBase)).toBe(true);
    });

    it("updateTab sees an allowance as a change", () => {
        const state = { tabs: [{ id: "a", url: "file:///tmp/a.html" }], activeId: "a" };
        const next = updateTab(state, "a", { allowed: true });
        expect(next).not.toBe(state);
        expect(next.tabs[0].allowed).toBe(true);
        expect(updateTab(next, "a", { allowed: true })).toBe(next);
    });
});

describe("which panels are created allowed", () => {
    const file = "file:///tmp/report/index.html";

    it("a page the user typed is saved allowed, in meta only the window writes", () => {
        const meta = typedBlockDef(file).meta as Record<string, any>;
        expect(meta.url).toBe(file);
        const tabs = meta[BrowserTabsMetaKey];
        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toMatchObject({ url: file, allowed: true });
        expect(meta[BrowserActiveMetaKey]).toBe(tabs[0].id);
        expect(needsLocalAsk(readBrowserState(meta, "about:blank").tabs[0], null, AppBase)).toBe(false);
    });

    it("a page a terminal queued, or an agent's tab, is not", () => {
        const queue = readOpenRequests({
            [BrowserOpenKeyPrefix + "1"]: file,
            [BrowserOpenKeyPrefix + "2"]: { url: file, keepfocus: true },
            [BrowserOpenKeyPrefix + "3"]: { url: file, agent: true, tabid: "agent-1" },
        });
        expect(queue).toHaveLength(3);
        for (const request of queue) {
            const def = request.agent
                ? besideBlockDef({ id: request.tabId, url: request.url })
                : besideBlockDef({ url: request.url }, { ask: request.ask, keepFocus: request.keepFocus });
            const state = readBrowserState(def.meta as Record<string, any>, "about:blank");
            expect(state.tabs[0].allowed, request.id).toBeUndefined();
            expect(needsLocalAsk(state.tabs[0], null, AppBase), request.id).toBe(true);
        }
    });

    it("a page moved or copied to another panel keeps the answer it had", () => {
        const allowed = readBrowserState(
            besideBlockDef({ id: "x", url: file, allowed: true }).meta as Record<string, any>,
            "about:blank"
        );
        expect(allowed.tabs[0].allowed).toBe(true);
        const asked = readBrowserState(
            besideBlockDef({ id: "x", url: file, allowed: false }).meta as Record<string, any>,
            "about:blank"
        );
        expect(asked.tabs[0].allowed).toBeUndefined();
    });
});
