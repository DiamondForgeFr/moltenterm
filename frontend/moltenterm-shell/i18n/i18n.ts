// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's interface language (FR-I18N-001, DS-I18N-001, DS-I18N-002). The resolved language lives in one atom
// of the I18n model, computed from app:language (the settings atom, so the settings screen, settings.json and
// `wsh setconfig` all apply live) and the OS preferred languages Electron main reads with
// app.getPreferredSystemLanguages(): never navigator.language, which on macOS follows the bundle's localizations.
// Nothing is written when following the OS. Components use useT(), models and menus the plain t().

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { useCallback } from "react";
import {
    availableLanguageCodes,
    availableLanguages,
    I18nVars,
    LanguageInfo,
    onLanguagesChange,
    resolveLanguage,
    SystemLanguage,
    translate,
} from "./i18n-core";

export type TFunction = (key: string, vars?: I18nVars) => string;

export const AppLanguageSettingKey = "app:language";

type LocaleListener = (locale: string) => void;

// The page's lang attribute: screen readers, hyphenation and spell checking follow the interface language.
function setDocumentLang(locale: string) {
    if (typeof document === "undefined") return;
    document.documentElement?.setAttribute("lang", locale);
}

export class I18nModel {
    private static instance: I18nModel | null = null;

    languageSettingAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
    osLanguagesAtom = jotai.atom<string[]>([]) as jotai.PrimitiveAtom<string[]>;
    // Bumped when a language is added or its texts change (a language pack, #624).
    languagesVersionAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;

    resolutionAtom!: jotai.Atom<{ locale: string; unknown: string }>;
    localeAtom!: jotai.Atom<string>;
    // The language following the OS would give, for the picker's "Same as the system" choice.
    systemLocaleAtom!: jotai.Atom<string>;
    languagesAtom!: jotai.Atom<LanguageInfo[]>;

    listeners = new Set<LocaleListener>();
    lastLocale: string = null;

    private constructor() {
        this.resolutionAtom = jotai.atom((get) => {
            get(this.languagesVersionAtom);
            return resolveLanguage(get(this.languageSettingAtom), get(this.osLanguagesAtom), availableLanguageCodes());
        });
        this.localeAtom = jotai.atom((get) => get(this.resolutionAtom).locale);
        this.systemLocaleAtom = jotai.atom((get) => {
            get(this.languagesVersionAtom);
            return resolveLanguage(SystemLanguage, get(this.osLanguagesAtom), availableLanguageCodes()).locale;
        });
        this.languagesAtom = jotai.atom((get) => {
            get(this.languagesVersionAtom);
            return availableLanguages();
        });
        onLanguagesChange(() => globalStore.set(this.languagesVersionAtom, (v) => v + 1));
        globalStore.sub(this.localeAtom, () => this.notifyLocale());
        this.lastLocale = globalStore.get(this.localeAtom);
        setDocumentLang(this.lastLocale);
    }

    static getInstance(): I18nModel {
        if (!I18nModel.instance) {
            I18nModel.instance = new I18nModel();
        }
        return I18nModel.instance;
    }

    static resetInstance(): void {
        I18nModel.instance = null;
    }

    getLocale(): string {
        return globalStore.get(this.localeAtom);
    }

    setLanguageSetting(value: string) {
        globalStore.set(this.languageSettingAtom, value ?? "");
    }

    setOsLanguages(languages: string[]) {
        globalStore.set(
            this.osLanguagesAtom,
            Array.isArray(languages) ? languages.filter((l) => typeof l === "string") : []
        );
    }

    // Called with the new code each time the resolved language changes (MoltenApi's onLocaleChange, Electron main).
    onLocaleChange(listener: LocaleListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notifyLocale() {
        const locale = this.getLocale();
        if (locale === this.lastLocale) return;
        this.lastLocale = locale;
        setDocumentLang(locale);
        for (const listener of [...this.listeners]) {
            try {
                listener(locale);
            } catch (e) {
                console.error("locale listener", e);
            }
        }
    }
}

export function getLocale(): string {
    return I18nModel.getInstance().getLocale();
}

// The text of a key in the current language, for models, menus and anything outside React.
export function t(key: string, vars?: I18nVars): string {
    return translate(getLocale(), key, vars);
}

export function useLocale(): string {
    return jotai.useAtomValue(I18nModel.getInstance().localeAtom, { store: globalStore });
}

// The translate function of the current language; the component renders again when the language changes.
export function useT(): TFunction {
    const locale = useLocale();
    return useCallback((key: string, vars?: I18nVars) => translate(locale, key, vars), [locale]);
}
