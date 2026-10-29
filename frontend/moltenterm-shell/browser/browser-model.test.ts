// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    activateTab,
    addTab,
    besideBlockDef,
    BrowserActiveMetaKey,
    BrowserKeepFocusMetaKey,
    browserMeta,
    BrowserState,
    BrowserTabsMetaKey,
    browserTabTitle,
    closeTab,
    addressOfPage,
    isBlankPage,
    isStartPage,
    StartPageUrl,
    moveTab,
    PanelTabs,
    readBrowserState,
    servingTabOf,
    shownAddress,
    splitOutTabs,
    toBrowserUrl,
    updateTab,
} from "./browser-model";

describe("shownAddress (FR-SHELL-086)", () => {
    it.each([
        ["https://github.com/", "github.com"],
        ["https://github.com/org/repo/issues/12", "github.com/org/repo/issues/12"],
        ["http://localhost:5173/", "localhost:5173"],
        ["https://a.dev/?q=1", "a.dev/?q=1"],
        ["file:///tmp/x.html", "file:///tmp/x.html"],
        ["about:blank", "about:blank"],
        ["", ""],
    ])("%s reads %s", (url, shown) => {
        expect(shownAddress(url)).toBe(shown);
    });
});

function ids() {
    let n = 0;
    return () => `t${++n}`;
}

const three: BrowserState = {
    tabs: [
        { id: "a", url: "https://a.dev" },
        { id: "b", url: "https://b.dev" },
        { id: "c", url: "https://c.dev" },
    ],
    activeId: "b",
};

describe("readBrowserState", () => {
    it("starts with one tab on the block URL or the default page", () => {
        expect(readBrowserState({ url: "https://x.dev" }, "https://home", ids())).toEqual({
            tabs: [{ id: "t1", url: "https://x.dev" }],
            activeId: "t1",
        });
        expect(readBrowserState({}, "https://home", ids()).tabs[0].url).toBe("https://home");
    });

    it("reads saved tabs and drops broken entries", () => {
        const state = readBrowserState(
            {
                "molten:browser:tabs": [{ id: "a", url: "https://a.dev", title: "A" }, { id: 3 }, null],
                "molten:browser:active": "missing",
            },
            "https://home"
        );
        expect(state).toEqual({ tabs: [{ id: "a", url: "https://a.dev", title: "A" }], activeId: "a" });
    });

    it("round-trips through the block meta", () => {
        const state = updateTab(three, "a", { title: "A" });
        expect(readBrowserState(browserMeta(state), "x")).toEqual(state);
    });
});

describe("tab operations", () => {
    it("adds a tab after the active one and activates it", () => {
        const state = addTab(three, "https://new.dev", () => "n");
        expect(state.tabs.map((t) => t.id)).toEqual(["a", "b", "n", "c"]);
        expect(state.activeId).toBe("n");
    });

    it("closes tabs and picks the next active one", () => {
        expect(closeTab(three, "b")).toMatchObject({ activeId: "c" });
        expect(closeTab({ ...three, activeId: "c" }, "c")).toMatchObject({ activeId: "b" });
        expect(closeTab(three, "a")).toMatchObject({ activeId: "b" });
        const one = { tabs: [three.tabs[0]], activeId: "a" };
        expect(closeTab(one, "a")).toBe(one);
    });

    it("activates, moves and updates tabs", () => {
        expect(activateTab(three, "c").activeId).toBe("c");
        expect(activateTab(three, "zz")).toBe(three);
        expect(moveTab(three, "a", 2).tabs.map((t) => t.id)).toEqual(["b", "c", "a"]);
        expect(moveTab(three, "c", 0).tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
        expect(updateTab(three, "b", { url: "https://b.dev" })).toBe(three);
        expect(updateTab(three, "b", { title: "B" }).tabs[1].title).toBe("B");
    });
});

describe("toBrowserUrl", () => {
    it.each([
        ["https://github.com", "https://github.com"],
        ["github.com/DiamondForgeFr", "https://github.com/DiamondForgeFr"],
        ["localhost:5173", "http://localhost:5173"],
        ["about:blank", "about:blank"],
        ["wave terminal tabs", "https://duckduckgo.com/?q=wave%20terminal%20tabs"],
        ["   ", null],
    ])("turns %j into %j", (input, want) => {
        expect(toBrowserUrl(input)).toBe(want);
    });
});

describe("browserTabTitle", () => {
    it("shows the page title", () => {
        expect(browserTabTitle({ id: "a", url: "https://github.com/x", title: " GitHub - x " })).toBe("GitHub - x");
    });

    it("falls back to the host while the title is unknown", () => {
        expect(browserTabTitle({ id: "a", url: "https://github.com/x" })).toBe("github.com");
    });

    it("is empty for a page without a host", () => {
        expect(browserTabTitle({ id: "a", url: "about:blank" })).toBe("");
        expect(browserTabTitle(null)).toBe("");
    });
});

describe("servingTabOf (#1005)", () => {
    const servesApp = (url: string) => url.startsWith("http://localhost:5173");

    it("finds the tab already showing the launch, wherever its path is", () => {
        const panels: PanelTabs[] = [
            {
                blockId: "p1",
                state: {
                    tabs: [
                        { id: "docs", url: "https://docs.dev" },
                        { id: "app", url: "http://localhost:5173/settings" },
                    ],
                    activeId: "docs",
                },
            },
        ];
        expect(servingTabOf(panels, [], servesApp)).toEqual({ blockId: "p1", tabId: "app" });
    });

    it("is null when no tab shows it (the developer closed it)", () => {
        const panels: PanelTabs[] = [
            { blockId: "p1", state: { tabs: [{ id: "a", url: "https://a.dev" }], activeId: "a" } },
        ];
        expect(servingTabOf(panels, [], servesApp)).toBeNull();
        expect(servingTabOf([], [], servesApp)).toBeNull();
        expect(servingTabOf(null, null, servesApp)).toBeNull();
    });

    it("skips a handed-off entry, which is not a page here", () => {
        const panels: PanelTabs[] = [
            {
                blockId: "p1",
                state: { tabs: [{ id: "h", url: "http://localhost:5173", engine: "installed" }], activeId: "h" },
            },
        ];
        expect(servingTabOf(panels, [], servesApp)).toBeNull();
    });

    it("prefers the shown tab, then the most recently focused panel", () => {
        const twoTabs: BrowserState = {
            tabs: [
                { id: "x1", url: "http://localhost:5173/a" },
                { id: "x2", url: "http://localhost:5173/b" },
            ],
            activeId: "x2",
        };
        const other: BrowserState = { tabs: [{ id: "y1", url: "http://localhost:5173" }], activeId: "y1" };
        const panels: PanelTabs[] = [
            { blockId: "p1", state: twoTabs },
            { blockId: "p2", state: other },
        ];
        expect(servingTabOf(panels, ["p1"], servesApp)).toEqual({ blockId: "p1", tabId: "x2" });
        expect(servingTabOf(panels, ["p2", "p1"], servesApp)).toEqual({ blockId: "p2", tabId: "y1" });
        // Without a focus history, the last panel is the one links go to.
        expect(servingTabOf(panels, [], servesApp)).toEqual({ blockId: "p2", tabId: "y1" });
    });
});

describe("one page per panel (#1187)", () => {
    it("a page beside starts as its own panel, keeping a given tab id", () => {
        const meta = besideBlockDef({ id: "agent-1", url: "https://x.dev", engine: "chrome" }).meta as any;
        expect(meta.view).toBe("molten-browser");
        expect(meta.url).toBe("https://x.dev");
        expect(meta[BrowserTabsMetaKey]).toEqual([{ id: "agent-1", url: "https://x.dev", engine: "chrome" }]);
        expect(meta[BrowserActiveMetaKey]).toBe("agent-1");
        const plain = besideBlockDef({ url: "https://y.dev" }, { ask: true, keepFocus: true }).meta as any;
        expect(plain[BrowserTabsMetaKey]).toBeUndefined();
        expect(plain[BrowserKeepFocusMetaKey]).toBe(true);
    });

    it("a panel saved with several tabs keeps its shown one and splits the others out in order", () => {
        const split = splitOutTabs({ ...three, activeId: "b" });
        expect(split.kept).toEqual({ tabs: [three.tabs[1]], activeId: "b" });
        expect(split.moved.map((t) => t.id)).toEqual(["a", "c"]);
        expect(splitOutTabs({ tabs: [three.tabs[0]], activeId: "a" })).toBeNull();
    });

    it("only an empty page is replaced in place", () => {
        expect(isBlankPage("about:blank")).toBe(true);
        expect(isBlankPage("")).toBe(true);
        expect(isBlankPage("https://a.dev")).toBe(false);
    });

    it("the start page is an empty page without an address of its own (FR-SHELL-111)", () => {
        expect(isStartPage(StartPageUrl)).toBe(true);
        expect(isStartPage("about:blank")).toBe(false);
        expect(isStartPage("https://github.com")).toBe(false);
        expect(isBlankPage(StartPageUrl)).toBe(true);
        expect(addressOfPage(StartPageUrl)).toBe("");
        expect(addressOfPage("https://a.dev/x")).toBe("https://a.dev/x");
    });
});
