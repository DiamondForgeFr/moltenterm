// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The short accessibility pass (FR-SHELL-099, #1328): 24 px targets, the 2 px focus ring, an accessible name for tiles
// and the Files buttons, and the same hidden-files words in Files and in Preferences.

import { atoms, WOS } from "@/app/store/global";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { atom } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { TemporaryViews } from "./workspace-sidebar";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

const env = {
    getSettingsKeyAtom: () => atom(null),
    atoms,
    wos: WOS,
    showContextMenu: () => {},
};

function render(ids: string[]): string {
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env as any}>
            <TemporaryViews ids={ids} activeTabId={null} asideRef={createRef<HTMLElement>()} />
        </WaveEnvContext.Provider>
    );
}

function openingTag(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at, testId).toBeGreaterThanOrEqual(0);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

function readCss(...parts: string[]): string {
    return fs.readFileSync(path.join(__dirname, ...parts), "utf8");
}

function rule(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
}

describe("targets of 24 px (WCAG 2.5.8)", () => {
    it("gives Clear, a row's pin and a row's close 24 px", () => {
        const html = render(["tab-x"]);
        expect(openingTag(html, "sidebar-temporary-clear")).toMatch(/class="[^"]*\bmin-h-6\b/);
        expect(openingTag(html, "sidebar-pin-view")).toMatch(/class="[^"]*\bh-6 w-6\b/);
        expect(openingTag(html, "tab-close")).toMatch(/class="[^"]*\bh-6 w-6\b/);
    });

    it("keeps every workspace dot in a 24 px slot, and a tile's revert at 24 px", () => {
        const css = readCss("sidebar.css");
        expect(rule(css, ".mt-sb-dots.is-many .mt-sb-dot")).toContain("width: 24px");
        expect(rule(css, ".mt-sb-revert")).toContain("width: 24px");
        expect(rule(css, ".mt-sb-revert")).toContain("height: 24px");
    });
});

describe("the focus ring", () => {
    it.each([
        ["the sidebar", [".mt-sb :focus-visible"], ["sidebar.css"]],
        ["the library", [".mt-lib :focus-visible"], ["..", "library", "library.css"]],
    ])("is the fixed --mt-focus, 2 px with a 2 px offset, in %s", (_name, [selector], file) => {
        const body = rule(readCss(...(file as string[])), selector as string);
        expect(body).toContain("outline: 2px solid var(--mt-focus-ring)");
        expect(body).toContain("outline-offset: 2px");
        expect(body).not.toContain("255 255 255");
    });
});

describe("the build badge", () => {
    it("is never dimmed with an opacity, which read it at 2.88:1", () => {
        expect(rule(readCss("sidebar.css"), ".mt-sb-build")).not.toContain("opacity");
        expect(rule(readCss("sidebar.css"), ".mt-sb-build:hover,\n.mt-sb-build:focus-visible")).not.toContain("opacity");
    });
});

describe("names and words", () => {
    it.each([
        ["en", en],
        ["fr", fr],
    ] as any[])("ships the tile label and the parent folder name in %s", (_lang, dict) => {
        expect(dict.sidebar.pins.tileLabel).toContain("{name}");
        expect(dict.sidebar.pins.tileChangedLabel).toBeTruthy();
        expect(dict.wave.files.parentFolder).toBeTruthy();
    });

    it("reads a tile as its view name followed by the word view, never by its glyphs", () => {
        expect(en.sidebar.pins.tileLabel.replace("{name}", "Scoping")).toBe("Scoping, pinned view");
        expect(fr.sidebar.pins.tileLabel.replace("{name}", "Cadrage")).toBe("Cadrage, vue épinglée");
    });

    it("says the same thing about hidden files in Files and in Preferences", () => {
        const preferences = (dict: any) => {
            const found: string[] = [];
            const walk = (node: any, key: string) => {
                if (node == null || typeof node !== "object") {
                    return;
                }
                if (key === "preview:showhiddenfiles") {
                    found.push(node.label);
                }
                for (const [k, v] of Object.entries(node)) {
                    walk(v, k);
                }
            };
            walk(dict, "");
            return found;
        };
        for (const dict of [en, fr] as any[]) {
            expect(preferences(dict)).toEqual([dict.wave.files.showHidden]);
            expect(dict.wave.files.hideHidden).toBeUndefined();
        }
        expect(en.wave.files.showHidden).toBe("Show hidden files");
    });

    it("tells the close button's words apart from a browser tab's", () => {
        expect(en.shell.hold.closeLabel).toMatch(/^Close view/);
        expect(fr.shell.hold.closeLabel).toMatch(/^Fermer la vue/);
    });
});
