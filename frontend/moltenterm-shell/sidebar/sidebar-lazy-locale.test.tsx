// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar never keeps a raw key while the interface language loads on demand (#1215): a dictionary chunk that
// fails once is fetched again, and a dictionary file changed while the app runs (a pull under the dev server, which
// had kept serving the dictionaries it started with) replaces the texts on screen.

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

type Core = typeof import("../i18n/i18n-core");
type I18n = typeof import("../i18n/i18n");
type Sidebar = typeof import("./workspace-sidebar");
type Dict = Record<string, any>;

// A key left in the markup: dotted lowercase words, as in sidebar.temporary.title.
const RawKeyRegex = /\b[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){2,}\b/;

let core: Core;
let i18n: I18n;
let sidebar: Sidebar;
let english: Dict;
let french: Dict;
let frenchAttempts = 0;

// Dictionaries as a dev server started before the sidebar's keys were added serves them.
function withoutTemporaryTitle(dict: Dict): Dict {
    const copy = structuredClone(dict);
    delete copy.sidebar.temporary.title;
    return copy;
}

// A fresh module graph whose shipped dictionaries load on demand, as in the renderer, from loaders the test controls.
beforeAll(async () => {
    english = (await import("../i18n/locales/en.json")).default as Dict;
    french = (await import("../i18n/locales/fr.json")).default as Dict;
    vi.resetModules();
    vi.doMock("../i18n/i18n-locales-lazy", () => ({}));
    core = await import("../i18n/i18n-core");
    core.provideShippedLanguages({
        "./locales/en.json": async () => withoutTemporaryTitle(english),
        "./locales/fr.json": async () => {
            frenchAttempts++;
            if (frenchAttempts === 1) throw new Error("chunk not served");
            return withoutTemporaryTitle(french);
        },
    });
    i18n = await import("../i18n/i18n");
    sidebar = await import("./workspace-sidebar");
    const { initGlobalAtoms } = await import("@/app/store/global-atoms");
    initGlobalAtoms({ tabId: "tab-l", windowId: "win-l", clientId: "c", platform: "darwin" } as any);
}, 120_000);

function renderTemporaryViews(): string {
    return renderToStaticMarkup(
        <sidebar.TemporaryViews ids={[]} activeTabId={null} asideRef={createRef<HTMLElement>()} />
    );
}

describe("sidebar texts with the language loaded on demand (#1215)", () => {
    it("loads the language after a failed chunk, then shows a changed dictionary without raw keys", async () => {
        const model = i18n.I18nModel.getInstance();
        model.setLanguageSetting("fr");
        // The app renders even when the language failed to load (whenMoltentermI18nReady).
        await model.whenReady().catch(() => {});
        expect(frenchAttempts).toBe(2);
        expect(i18n.getLocale()).toBe("fr");

        let html = renderTemporaryViews();
        expect(html).toContain("Nouvelle vue");
        expect(html).toMatch(RawKeyRegex);

        core.replaceShippedDictionary("en", english);
        core.replaceShippedDictionary("fr", french);
        html = renderTemporaryViews();
        expect(html).not.toMatch(RawKeyRegex);
        expect(html).toContain("Vues temporaires");
        expect(html).toContain("Nouvelle vue");
    });

    it("loads English, the fallback, once the active language is there", async () => {
        await core.loadFallbackLanguage();
        expect(core.isLanguageLoaded("en")).toBe(true);
    });
});
