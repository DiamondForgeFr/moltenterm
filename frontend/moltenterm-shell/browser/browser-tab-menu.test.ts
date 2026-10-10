// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BrowserState } from "./browser-model";
import { BrowserTabActions, browserTabMenu } from "./browser-tab-menu";

function actions() {
    const calls: string[] = [];
    const record = (name: string) => (id: string) => calls.push(`${name} ${id}`);
    const a: BrowserTabActions = {
        reloadTab: record("reload"),
        duplicateTab: record("duplicate"),
        copyTabLink: record("copy"),
        closeTab: record("close"),
        closeOtherTabs: record("closeothers"),
    };
    return { a, calls };
}

const state: BrowserState = {
    tabs: [
        { id: "t1", url: "https://example.com" },
        { id: "t2", url: "https://example.org" },
    ],
    activeId: "t1",
};

function labels(menu: ContextMenuItem[]): string[] {
    return menu.map((i) => (i.type === "separator" ? "---" : i.label));
}

describe("browser tab menu (FR-SHELL-051 AC3, DS-SHELL-092)", () => {
    it("lists Reload, Duplicate, Copy link, Close and Close others, each acting on the clicked tab", () => {
        const { a, calls } = actions();
        const menu = browserTabMenu(state, state.tabs[1], a);
        expect(labels(menu)).toEqual(["Reload", "Duplicate", "Copy link", "---", "Close", "Close others"]);
        menu.filter((i) => i.click != null).forEach((i) => i.click());
        expect(calls).toEqual(["reload t2", "duplicate t2", "copy t2", "close t2", "closeothers t2"]);
    });

    it("disables Close and Close others on the only tab", () => {
        const { a } = actions();
        const only: BrowserState = { tabs: [state.tabs[0]], activeId: "t1" };
        const menu = browserTabMenu(only, only.tabs[0], a);
        expect(menu.find((i) => i.label === "Close").enabled).toBe(false);
        expect(menu.find((i) => i.label === "Close others").enabled).toBe(false);
    });

    it("leaves Reload out for a page handed off to the installed browser", () => {
        const { a } = actions();
        const menu = browserTabMenu(state, { id: "t3", url: "https://x.dev", engine: "brave" }, a);
        expect(labels(menu)[0]).toBe("Duplicate");
    });
});
