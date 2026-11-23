// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { followPageTitle, titleToShow, TitledView, TitledWindow } from "./moltenterm-window-title-sync";

function makeView(title: string) {
    const listeners: ((e: { preventDefault: () => void }, title: string) => void)[] = [];
    let prevented = 0;
    const view: TitledView = {
        webContents: {
            getTitle: () => title,
            on: (_event, listener) => {
                listeners.push(listener);
            },
        },
    };
    const emit = (next: string) => {
        title = next;
        listeners.forEach((l) => l({ preventDefault: () => prevented++ }, next));
    };
    return { view, emit, listeners, prevented: () => prevented };
}

function makeWindow() {
    const titles: string[] = [];
    const win: TitledWindow = { setTitle: (t) => titles.push(t), activeTabView: null };
    return { win, titles };
}

// FR-SHELL-158: the system's window list reads the window's title, which names the context.
describe("the window's title follows the page on screen", () => {
    it("takes the page's title when the view comes on screen", () => {
        const { view } = makeView("MoltenTerm — DiamondForge - Terminal");
        const { win, titles } = makeWindow();
        followPageTitle(win, view, () => win);
        expect(titles).toEqual(["MoltenTerm — DiamondForge - Terminal"]);
    });

    it("keeps its title when the page has none yet", () => {
        const { view } = makeView("  ");
        const { win, titles } = makeWindow();
        followPageTitle(win, view, () => win);
        expect(titles).toEqual([]);
    });

    it("follows a later title of the view on screen, a rename of the context included", () => {
        const { view, emit, prevented } = makeView("MoltenTerm — Book - Terminal");
        const { win, titles } = makeWindow();
        win.activeTabView = view;
        followPageTitle(win, view, () => win);
        emit("MoltenTerm — Novel - Terminal");
        expect(titles).toEqual(["MoltenTerm — Book - Terminal", "MoltenTerm — Novel - Terminal"]);
        expect(prevented()).toBe(1);
    });

    it("ignores the title of a view that is not on screen, and of one whose window is gone", () => {
        const { view, emit } = makeView("MoltenTerm — Book - Terminal");
        const { win, titles } = makeWindow();
        followPageTitle(win, view, () => win);
        emit("hidden view's title");
        expect(titles).toEqual(["MoltenTerm — Book - Terminal"]);
        win.activeTabView = view;
        const gone = makeView("x");
        followPageTitle(win, gone.view, () => null);
        gone.emit("later");
        expect(titles).toEqual(["MoltenTerm — Book - Terminal", "x"]);
    });

    it("listens once per view, however many times it comes on screen", () => {
        const { view, listeners } = makeView("MoltenTerm - Terminal");
        const { win } = makeWindow();
        followPageTitle(win, view, () => win);
        followPageTitle(win, view, () => win);
        followPageTitle(win, view, () => win);
        expect(listeners).toHaveLength(1);
    });

    it("gives nothing and breaks nothing for a view whose page is gone or that is not a page at all", () => {
        const { win, titles } = makeWindow();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const gone = {
            webContents: {
                getTitle: () => {
                    throw new Error("Object has been destroyed");
                },
                on: () => {},
            },
        } as TitledView;
        expect(() => followPageTitle(win, gone, () => win)).not.toThrow();
        expect(() => followPageTitle(win, {} as TitledView, () => win)).not.toThrow();
        expect(() => followPageTitle(win, null as unknown as TitledView, () => win)).not.toThrow();
        expect(titles).toEqual([]);
        log.mockRestore();
    });

    it("trims a title and refuses a non-text one", () => {
        expect(titleToShow("  MoltenTerm  ")).toBe("MoltenTerm");
        expect(titleToShow(undefined as unknown as string)).toBe("");
    });
});
