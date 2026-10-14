// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { availableLanguageCodes, flattenKeys, onLanguagesChange, shippedDictionary, translate } from "./i18n-core";
import { checkLanguagePack, isLanguageCode } from "./language-pack";
import { noticeDue } from "./language-pack-notice";
import { i18nCheck, i18nExport, i18nStatus, untranslatedCount } from "./language-pack-tools";
import { LanguagePackRegistry, languagePacks, resetLanguagePacks } from "./language-packs";

const English = shippedDictionary("en");
const Total = flattenKeys(English).length;

afterEach(() => {
    resetLanguagePacks();
});

describe("checkLanguagePack (DS-I18N-010)", () => {
    it("accepts a partial pack and counts what is missing", () => {
        const check = checkLanguagePack(
            "es",
            { language: { name: "Español", system: "Igual que el sistema ({name})" }, common: { close: "" } },
            English
        );
        expect(check.ok).toBe(true);
        expect(check.translated).toBe(2);
        expect(check.missing).toHaveLength(Total - 2);
        // An empty string counts as missing and is not registered (TC-I18N-004, AC3).
        expect(check.missing).toContain("common.close");
        expect((check.dict as any).common).toBeUndefined();
    });

    it("refuses a pack that renames a placeholder, naming the key and the placeholder (TC-I18N-010)", () => {
        const check = checkLanguagePack(
            "es",
            { language: { system: "Igual que el sistema ({nombre})" }, common: { close: "Cerrar" } },
            English
        );
        expect(check.ok).toBe(false);
        expect(check.dict).toBeNull();
        expect(check.errors).toHaveLength(1);
        expect(check.errors[0].key).toBe("language.system");
        expect(check.errors[0].message).toContain("{name} is missing");
        expect(check.errors[0].message).toContain("{nombre} is not in English");
    });

    it("refuses a dropped placeholder and a non-string value", () => {
        expect(checkLanguagePack("es", { language: { system: "Igual que el sistema" } }, English).ok).toBe(false);
        const check = checkLanguagePack("es", { common: { close: 3 } }, English);
        expect(check.ok).toBe(false);
        expect(check.errors[0].key).toBe("common.close");
    });

    it("ignores keys English does not know, with a warning (AC3)", () => {
        const check = checkLanguagePack("es", { common: { close: "Cerrar", nope: "x" }, extra: "y" }, English);
        expect(check.ok).toBe(true);
        expect(check.warnings.map((w) => w.key).sort()).toEqual(["common.nope", "extra"]);
        expect((check.dict as any).common).toEqual({ close: "Cerrar" });
        expect((check.dict as any).extra).toBeUndefined();
    });

    it("checks the language code", () => {
        expect(isLanguageCode("es")).toBe(true);
        expect(isLanguageCode("pt-BR")).toBe(true);
        expect(isLanguageCode("es-419")).toBe(true);
        expect(isLanguageCode("spanish")).toBe(false);
        expect(checkLanguagePack("../x", {}, English).ok).toBe(false);
        expect(checkLanguagePack("es", [], English).ok).toBe(false);
    });
});

describe("language pack registry (DS-I18N-008)", () => {
    it("adds a new language that falls back to English, and removes it again", () => {
        const packs = languagePacks();
        packs.apply([{ modId: "lang-es", code: "es", name: "Español", dict: { common: { close: "Cerrar" } } }]);
        expect(availableLanguageCodes()).toContain("es");
        expect(translate("es", "common.close")).toBe("Cerrar");
        expect(translate("es", "common.cancel")).toBe("Cancel");
        expect(packs.sourceOf("es")).toBe("lang-es");
        expect(untranslatedCount("es")).toBe(Total - 1);
        packs.apply([]);
        expect(availableLanguageCodes()).not.toContain("es");
    });

    it("overrides only the keys a pack for a shipped language holds; removing it restores them (TC-I18N-012)", () => {
        const shipped = translate("fr", "common.cancel");
        const close = translate("fr", "common.close");
        languagePacks().apply([
            { modId: "fr-fix", code: "fr", name: "Français", dict: { common: { close: "Clore" } } },
        ]);
        expect(translate("fr", "common.close")).toBe("Clore");
        expect(translate("fr", "common.cancel")).toBe(shipped);
        languagePacks().apply([]);
        expect(translate("fr", "common.close")).toBe(close);
    });

    it("gives a shared code to the most recently enabled pack and reports the other", () => {
        const packs = languagePacks();
        packs.apply([
            { modId: "a", code: "es", name: "Español", dict: { common: { close: "A" } }, enabledAt: 2000 },
            { modId: "b", code: "es", name: "Español", dict: { common: { close: "B" } }, enabledAt: 1000 },
        ]);
        expect(translate("es", "common.close")).toBe("A");
        expect(packs.shadowed).toEqual([{ modId: "b", code: "es", by: "a" }]);
        expect(packs.activePacks().map((p) => p.modId)).toEqual(["a"]);
    });

    it("replaces a changed pack in one change: its language never goes missing", () => {
        const packs = languagePacks();
        const pack = { modId: "lang-es", code: "es", name: "Español", dict: { common: { close: "Cerrar" } } };
        packs.apply([pack]);
        const seen: boolean[] = [];
        const off = onLanguagesChange(() => seen.push(availableLanguageCodes().includes("es")));
        packs.apply([{ ...pack, dict: { common: { close: "Cierra" } } }]);
        off();
        expect(seen).toEqual([true]);
        expect(translate("es", "common.close")).toBe("Cierra");
    });

    it("keeps an unchanged pack registered across a reload", () => {
        const registry = new LanguagePackRegistry();
        const pack = { modId: "lang-es", code: "es", name: "Español", dict: { common: { close: "Cerrar" } } };
        registry.apply([pack]);
        const first = registry.registrations.get("es");
        registry.apply([{ ...pack, dict: { common: { close: "Cerrar" } } }]);
        expect(registry.registrations.get("es")).toBe(first);
        registry.apply([{ ...pack, dict: { common: { close: "Cierra" } } }]);
        expect(registry.registrations.get("es")).not.toBe(first);
        expect(translate("es", "common.close")).toBe("Cierra");
        registry.apply([]);
    });
});

describe("molten i18n (DS-I18N-009)", () => {
    it("exports the English reference with placeholders", () => {
        const out = i18nExport("", false);
        expect(out.count).toBe(Total);
        expect(out.keys.find((k) => k.key === "language.system").placeholders).toEqual(["name"]);
        expect((out.dict as any).common.close).toBe("Close");
    });

    it("exports the keys a language still lacks, and the current translation", () => {
        languagePacks().apply([
            { modId: "lang-es", code: "es", name: "Español", dict: { common: { close: "Cerrar" } } },
        ]);
        const missing = i18nExport("es", true);
        expect(missing.count).toBe(Total - 1);
        expect(missing.keys.some((k) => k.key === "common.close")).toBe(false);
        const current = i18nExport("es", false);
        expect((current.dict as any).common).toEqual({ close: "Cerrar" });
        expect(current.keys.find((k) => k.key === "common.close").translation).toBe("Cerrar");
        // A language not installed yet: every key, to translate.
        expect(i18nExport("de", true).count).toBe(Total);
        expect(() => i18nExport("de", false)).toThrow(/no language "de"/);
    });

    it("checks a file as the host does", () => {
        expect(i18nCheck("es", "{oops").ok).toBe(false);
        const bad = i18nCheck("es", JSON.stringify({ language: { system: "x {n}" } }));
        expect(bad.ok).toBe(false);
        expect(bad.errors[0].key).toBe("language.system");
        const good = i18nCheck("es", JSON.stringify({ common: { close: "Cerrar" } }));
        expect(good).toMatchObject({ ok: true, translated: 1, missing: Total - 1, total: Total });
    });

    it("reports each language's untranslated count and source", () => {
        languagePacks().apply([
            { modId: "lang-es", code: "es", name: "Español", dict: { common: { close: "Cerrar" } } },
        ]);
        const status = i18nStatus("es");
        expect(status.active).toBe("es");
        expect(status.languages.find((l) => l.code === "en")).toMatchObject({ shipped: true, untranslated: 0 });
        expect(status.languages.find((l) => l.code === "fr")).toMatchObject({ shipped: true, untranslated: 0 });
        expect(status.languages.find((l) => l.code === "es")).toMatchObject({
            shipped: false,
            pack: "lang-es",
            untranslated: Total - 1,
            total: Total,
        });
    });
});

describe("untranslated notice (DS-I18N-011)", () => {
    it("is due once per version and language, for a pack's own language with strings missing", () => {
        expect(noticeDue("es", 12, "1.0.0", {}, true)).toBe(true);
        expect(noticeDue("es", 12, "1.0.0", { es: "1.0.0" }, true)).toBe(false);
        expect(noticeDue("es", 12, "1.0.1", { es: "1.0.0" }, true)).toBe(true);
        expect(noticeDue("es", 0, "1.0.0", {}, true)).toBe(false);
        expect(noticeDue("fr", 3, "1.0.0", {}, true)).toBe(false);
        expect(noticeDue("es", 3, "1.0.0", {}, false)).toBe(false);
    });
});
