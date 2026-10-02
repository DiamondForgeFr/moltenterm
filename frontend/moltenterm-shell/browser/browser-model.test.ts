// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    activateTab,
    addTab,
    browserMeta,
    BrowserState,
    closeTab,
    moveTab,
    readBrowserState,
    toBrowserUrl,
    updateTab,
} from "./browser-model";

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
