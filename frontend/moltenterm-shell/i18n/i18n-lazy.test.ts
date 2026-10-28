// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer loads only the active language's dictionary (#1213, NFR-PERF-003): another one loads when it is chosen,
// and the interface stays on a language whose texts are there until it has.

import { beforeAll, describe, expect, it, vi } from "vitest";

type Core = typeof import("./i18n-core");
type I18n = typeof import("./i18n");
type Store = typeof import("@/app/store/jotaiStore");

let core: Core;
let i18n: I18n;
let store: Store;

// A fresh module graph without the test setup's eager dictionaries: what the renderer starts with.
beforeAll(async () => {
    vi.resetModules();
    core = await import("./i18n-core");
    i18n = await import("./i18n");
    store = await import("@/app/store/jotaiStore");
}, 60_000);

describe("lazy dictionaries (#1213)", () => {
    it("knows the shipped languages and their names before loading them", () => {
        expect(core.availableLanguageCodes()).toEqual(["en", "fr"]);
        expect(core.isShippedLanguage("fr")).toBe(true);
        expect(core.availableLanguages().find((l) => l.code === "fr")?.name).toBe("Français");
    });

    it("shows the active language once loaded, then a newly chosen one only once its texts are there", async () => {
        const model = i18n.I18nModel.getInstance();
        model.setLanguageSetting("en");
        await model.whenReady();
        expect(core.isLanguageLoaded("en")).toBe(true);
        expect(i18n.getLocale()).toBe("en");
        expect(i18n.t("language.name")).toBe("English");

        expect(core.isLanguageLoaded("fr")).toBe(false);
        model.setLanguageSetting("fr");
        expect(i18n.getLocale()).toBe("en");
        expect(i18n.t("language.name")).toBe("English");
        await model.whenReady();
        expect(i18n.getLocale()).toBe("fr");
        expect(i18n.t("language.name")).toBe("Français");
        expect(store.globalStore.get(model.shownLocaleAtom)).toBe("fr");

        model.setLanguageSetting("en");
        expect(i18n.getLocale()).toBe("en");
    });

    it("needs English for a pack's language, which falls back to it", async () => {
        const remove = core.registerLanguage({ code: "xx", name: "Pack" }, { language: { name: "Pack" } });
        try {
            expect(core.isLanguageReady("xx")).toBe(core.isLanguageLoaded("en"));
            await core.loadLanguage("xx");
            expect(core.isLanguageReady("xx")).toBe(true);
            expect(core.translate("xx", "language.system", { name: "x" })).toBe(
                core.translate("en", "language.system", { name: "x" })
            );
        } finally {
            remove();
        }
    });

    it("loads every shipped dictionary on request, for the language tools", async () => {
        await core.loadShippedLanguages();
        expect(core.shippedDictionary("en")).toBeDefined();
        expect(core.shippedDictionary("fr")).toBeDefined();
        expect(await core.loadShippedDictionary("fr")).toBe(core.shippedDictionary("fr"));
        expect(core.hasKey("language.name")).toBe(true);
    });
});
