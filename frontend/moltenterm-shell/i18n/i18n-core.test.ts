// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    availableLanguageCodes,
    availableLanguages,
    formatNumber,
    interpolate,
    labelled,
    placeholders,
    preferredLocale,
    registerLanguage,
    resolveKey,
    resolveLanguage,
    translate,
    translateCount,
} from "./i18n-core";

describe("French typography (#1379)", () => {
    it("elides de, le, la and que before a value starting with a vowel", () => {
        expect(interpolate("Options de {name}", { name: "Espace de départ" }, "fr")).toBe("Options d'Espace de départ");
        expect(interpolate("Options de {name}", { name: "Client" }, "fr")).toBe("Options de Client");
        expect(interpolate("Options de {name}", { name: "Hugo" }, "fr")).toBe("Options de Hugo");
        expect(interpolate("Utiliser le logo de {name} ?", { name: "Atlas" }, "fr-FR")).toBe("Utiliser le logo d'Atlas ?");
        expect(interpolate("Copier le {thing}", { thing: "écran" }, "fr")).toBe("Copier l'écran");
        expect(interpolate("Voir la {thing}", { thing: "unité" }, "fr")).toBe("Voir l'unité");
        expect(interpolate("Il faut que {who} parte", { who: "Anne" }, "fr")).toBe("Il faut qu'Anne parte");
        expect(interpolate("De {name}", { name: "Ana" }, "fr")).toBe("D'Ana");
    });

    it("leaves other languages and words alone", () => {
        expect(interpolate("Options of {name}", { name: "Espace" }, "en")).toBe("Options of Espace");
        expect(interpolate("Options de {name}", { name: "Espace" }, "de")).toBe("Options de Espace");
        expect(interpolate("Options de {name}", { name: "Espace" })).toBe("Options de Espace");
        expect(interpolate("Fonde {name}", { name: "Ana" }, "fr")).toBe("Fonde Ana");
        expect(interpolate("{name} de {other}", { name: "Ana", other: "Eve" }, "fr")).toBe("Ana d'Eve");
    });

    it("translates with the language's elision", () => {
        expect(translate("fr", "sidebar.header.menu", { name: "Espace de départ" })).toBe("Options d'Espace de départ");
    });

    it("sets a no-break space before the label colon in French only", () => {
        expect(labelled("fr", "Thème", "Default Dark")).toBe("Thème\u00a0: Default Dark");
        expect(labelled("fr-CA", "Thème", "Default Dark")).toBe("Thème\u00a0: Default Dark");
        expect(labelled("en", "Theme", "Default Dark")).toBe("Theme: Default Dark");
    });
});

describe("resolveKey and interpolate (DS-I18N-001)", () => {
    const dict = { a: { b: "B {name}", empty: "", nested: { c: "C" } }, top: "T" };

    it("resolves dotted keys to strings only", () => {
        expect(resolveKey(dict, "a.b")).toBe("B {name}");
        expect(resolveKey(dict, "a.nested.c")).toBe("C");
        expect(resolveKey(dict, "top")).toBe("T");
        expect(resolveKey(dict, "a")).toBeUndefined();
        expect(resolveKey(dict, "a.missing")).toBeUndefined();
        expect(resolveKey(dict, "top.x")).toBeUndefined();
        expect(resolveKey(dict, "constructor")).toBeUndefined();
    });

    it("treats an empty translation as missing", () => {
        expect(resolveKey(dict, "a.empty")).toBeUndefined();
    });

    it("fills {name} placeholders and leaves unknown ones intact (AC5)", () => {
        expect(interpolate("Hi {name}, {count} new", { name: "Ana", count: 3 })).toBe("Hi Ana, 3 new");
        expect(interpolate("Hi {name} {other}", { name: "Ana" })).toBe("Hi Ana {other}");
        expect(interpolate("Hi {name}")).toBe("Hi {name}");
        expect(interpolate("{name}", { name: "<b>x</b>" })).toBe("<b>x</b>");
        expect(placeholders("{b} {a} {b}")).toEqual(["a", "b"]);
    });
});

describe("preferredLocale (TC-I18N-002)", () => {
    const supported = ["en", "fr"];

    it("matches the primary subtag in preference order", () => {
        expect(preferredLocale(["fr-CA", "en-US"], supported, "en")).toBe("fr");
        expect(preferredLocale(["fr_FR"], supported, "en")).toBe("fr");
        expect(preferredLocale(["de-DE", "en-US", "fr-FR"], supported, "en")).toBe("en");
        expect(preferredLocale(["de-DE", "ja"], supported, "en")).toBe("en");
        expect(preferredLocale([], supported, "en")).toBe("en");
    });
});

describe("resolveLanguage (DS-I18N-002)", () => {
    it("takes an explicit available language, else the OS's first spoken one", () => {
        expect(resolveLanguage("fr", ["en-US"])).toEqual({ locale: "fr", unknown: "" });
        expect(resolveLanguage("EN", ["fr-FR"])).toEqual({ locale: "en", unknown: "" });
        expect(resolveLanguage("system", ["fr-FR"])).toEqual({ locale: "fr", unknown: "" });
        expect(resolveLanguage("", ["fr-FR"])).toEqual({ locale: "fr", unknown: "" });
        expect(resolveLanguage(undefined, ["de", "en"])).toEqual({ locale: "en", unknown: "" });
    });

    it("resolves a value naming no language as system and reports it", () => {
        expect(resolveLanguage("klingon", ["fr-FR"])).toEqual({ locale: "fr", unknown: "klingon" });
    });
});

describe("translate (TC-I18N-004)", () => {
    it("ships English and French", () => {
        expect(availableLanguageCodes()).toEqual(expect.arrayContaining(["en", "fr"]));
        expect(availableLanguages()[0]).toEqual({ code: "en", name: "English" });
        expect(availableLanguages().find((l) => l.code === "fr")?.name).toBe("Français");
    });

    it("falls back to English for a key the language lacks, and to the key when English lacks it too", () => {
        const remove = registerLanguage({ code: "zz", name: "Test" }, { common: { cancel: "Zancel" } });
        try {
            expect(translate("zz", "common.cancel")).toBe("Zancel");
            expect(translate("zz", "common.close")).toBe("Close");
            expect(translate("zz", "no.such.key")).toBe("no.such.key");
            expect(availableLanguageCodes()).toContain("zz");
        } finally {
            remove();
        }
        expect(availableLanguageCodes()).not.toContain("zz");
        expect(translate("zz", "common.close")).toBe("Close");
    });

    it("overrides single keys of a shipped language and restores them when removed (#624)", () => {
        expect(translate("fr", "common.cancel")).toBe("Annuler");
        const remove = registerLanguage({ code: "fr", name: "Français" }, { common: { cancel: "Laisser tomber" } });
        expect(translate("fr", "common.cancel")).toBe("Laisser tomber");
        expect(translate("fr", "common.close")).toBe("Fermer");
        remove();
        expect(translate("fr", "common.cancel")).toBe("Annuler");
    });

    it("interpolates the translation", () => {
        expect(translate("fr", "appMenu.quit", { app: "MoltenTerm" })).toBe("Quitter MoltenTerm");
        expect(translate("en", "appMenu.quit", { app: "MoltenTerm" })).toBe("Quit MoltenTerm");
    });
});

describe("plurals and numbers in the interface language (#741)", () => {
    it("picks the form by the language's rule: French 0 and 1 are singular, English 0 is plural", () => {
        expect(translateCount("fr", "notif.center.bellUnread", 1)).toBe("Notifications, 1 non lue");
        expect(translateCount("fr", "notif.center.bellUnread", 0)).toBe("Notifications, 0 non lue");
        expect(translateCount("fr", "notif.center.bellUnread", 3)).toBe("Notifications, 3 non lues");
        expect(translateCount("fr", "rail.unread", 1)).toBe("1 non lue");
        expect(translateCount("fr", "settings.mods.usage.timers", 0)).toBe("0 minuteur");
        expect(translateCount("en", "settings.mods.usage.timers", 0)).toBe("0 timers");
        expect(translateCount("en", "settings.mods.usage.timers", 1)).toBe("1 timer");
    });

    it("writes decimals in the language's notation", () => {
        expect(formatNumber("fr", 0, 1)).toBe("0,0");
        expect(formatNumber("fr", 3.46, 1)).toBe("3,5");
        expect(formatNumber("en", 3.46, 1)).toBe("3.5");
        expect(formatNumber("en", 25)).toBe("25");
        expect(formatNumber("not a locale!", 1.5, 1)).toBe("1.5");
    });
});
