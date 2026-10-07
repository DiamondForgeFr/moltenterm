// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    BrowserList,
    browserIconClass,
    engineName,
    fallbackNotice,
    fallbackReason,
    localEngine,
    siteEngine,
    siteOf,
} from "./browser-engine";
import {
    BrowserNoticeMetaKey,
    BrowserState,
    addTab,
    browserBlockDef,
    browserMeta,
    readBrowserState,
    readOpenRequests,
    setTabEngine,
} from "./browser-model";

const list: BrowserList = {
    browsers: [
        { id: "brave", name: "Brave", path: "/Applications/Brave Browser.app" },
        { id: "chrome", name: "Chrome", path: "/Applications/Google Chrome.app" },
    ],
    chosen: { id: "brave", name: "Brave", path: "/Applications/Brave Browser.app" },
    default: "app",
};

describe("per-site choices (FR-BRW-002)", () => {
    const sites = { "Example.com": "brave", "docs.example.com": "app", "claude.ai": " Installed " };

    it("match the host, then its closest parent domain, like SiteEngine in Go", () => {
        expect(siteEngine(sites, "https://example.com/x")).toEqual({ engine: "brave", site: "example.com" });
        expect(siteEngine(sites, "https://app.example.com/x")).toEqual({ engine: "brave", site: "example.com" });
        expect(siteEngine(sites, "https://a.docs.example.com/")).toEqual({ engine: "app", site: "docs.example.com" });
        expect(siteEngine(sites, "https://claude.ai/new")).toEqual({ engine: "installed", site: "claude.ai" });
        expect(siteEngine(sites, "https://notexample.com/")).toEqual({ engine: "", site: "" });
        expect(siteEngine(sites, "not a url")).toEqual({ engine: "", site: "" });
    });

    it("record a page's site without www, and only for web pages", () => {
        expect(siteOf("https://www.GitHub.com/a")).toBe("github.com");
        expect(siteOf("http://localhost:3000/")).toBe("localhost");
        expect(siteOf("file:///tmp/a.html")).toBeNull();
        expect(siteOf("about:blank")).toBeNull();
    });

    it("route locally: the site's choice first, then browser:default, then the app", () => {
        expect(localEngine("", {}, "https://claude.ai/x")).toBe("app");
        expect(localEngine("app", undefined, "https://claude.ai/x")).toBe("app");
        expect(localEngine(" Installed ", {}, "https://claude.ai/x")).toBe("installed");
        expect(localEngine("", { "claude.ai": "Brave" }, "https://api.claude.ai/x")).toBe("brave");
        expect(localEngine("brave", { "github.com": "app" }, "https://github.com/x")).toBe("app");
    });
});

describe("engine names and notices", () => {
    it("name engines from the detected browsers", () => {
        expect(engineName("app", list)).toBe("MoltenTerm");
        expect(engineName("installed", list)).toBe("Brave");
        expect(engineName("chrome", list)).toBe("Chrome");
        expect(engineName("vivaldi", list)).toBe("Vivaldi");
        expect(engineName("custom", { ...list, chosen: { id: "custom", name: "Thorium", path: "/x" } })).toBe(
            "Thorium"
        );
    });

    it("use brand marks where Font Awesome Free has one", () => {
        expect(browserIconClass("brave")).toBe("fa-brands fa-brave");
        expect(browserIconClass("arc")).toBe("fa-solid fa-compass");
    });

    it("explain a fallback", () => {
        expect(fallbackNotice({ engine: "app" })).toBeNull();
        expect(fallbackReason({ engine: "app", fallback: "brave is not installed" })).toBe("Brave is not installed.");
        expect(fallbackNotice({ engine: "app", fallback: "Brave could not start: boom" })).toBe(
            "Brave could not start: boom. Opened in MoltenTerm instead."
        );
    });
});

describe("handed-off entries in the tab strip", () => {
    const ids = () => {
        let n = 0;
        return () => `t${++n}`;
    };
    const one: BrowserState = { tabs: [{ id: "a", url: "https://a.dev" }], activeId: "a" };

    it("are saved with their engine and read back", () => {
        const state = addTab(one, "https://claude.ai", ids(), { engine: "brave", activate: false });
        expect(state.activeId).toBe("a");
        expect(state.tabs[1]).toEqual({ id: "t1", url: "https://claude.ai", engine: "brave" });
        const meta = browserMeta(state);
        expect(readBrowserState(meta, "about:blank").tabs).toEqual(state.tabs);
    });

    it("drop an engine of app when read", () => {
        const meta = { "molten:browser:tabs": [{ id: "a", url: "https://a.dev", engine: "app" }] };
        expect(readBrowserState(meta, "about:blank").tabs).toEqual([{ id: "a", url: "https://a.dev" }]);
    });

    it("move between engines", () => {
        const handed = setTabEngine(one, "a", "brave");
        expect(handed.tabs[0]).toEqual({ id: "a", url: "https://a.dev", engine: "brave" });
        expect(setTabEngine(handed, "a", "brave")).toBe(handed);
        expect(setTabEngine(handed, "a", "app").tabs[0]).toEqual({ id: "a", url: "https://a.dev" });
        expect(setTabEngine(one, "missing", "brave")).toBe(one);
    });

    it("come from wsh as queued objects next to plain pages", () => {
        const meta = {
            "molten:browser:open:01": "https://plain.dev",
            "molten:browser:open:02": { url: "https://claude.ai", engine: "brave" },
            "molten:browser:open:03": { url: "https://x.dev", engine: "app" },
            "molten:browser:open:04": { engine: "brave" },
        };
        expect(readOpenRequests(meta)).toEqual([
            { id: "01", url: "https://plain.dev" },
            { id: "02", url: "https://claude.ai", engine: "brave" },
            { id: "03", url: "https://x.dev" },
        ]);
    });

    it("read the ask and keep-focus flags of a page a terminal program opened through BROWSER (FR-BRW-007)", () => {
        const meta = {
            "molten:browser:open:01": { url: "https://a.dev", ask: true, keepfocus: true },
            "molten:browser:open:02": { url: "https://b.dev", keepfocus: true },
            "molten:browser:open:03": { url: "https://c.dev", ask: "yes", keepfocus: 1 },
        };
        expect(readOpenRequests(meta)).toEqual([
            { id: "01", url: "https://a.dev", ask: true, keepFocus: true },
            { id: "02", url: "https://b.dev", keepFocus: true },
            { id: "03", url: "https://c.dev" },
        ]);
    });

    it("carry a fallback notice into a new panel", () => {
        expect(browserBlockDef("https://a.dev", "Brave is not installed.").meta[BrowserNoticeMetaKey]).toBe(
            "Brave is not installed."
        );
        expect(browserBlockDef("https://a.dev").meta).toEqual({ view: "molten-browser", url: "https://a.dev" });
    });
});
