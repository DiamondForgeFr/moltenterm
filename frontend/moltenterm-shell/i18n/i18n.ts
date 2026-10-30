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
    FallbackLanguage,
    formatNumber as formatLocaleNumber,
    I18nVars,
    isLanguageReady,
    labelled as labelledText,
    LanguageInfo,
    loadFallbackLanguage,
    loadLanguage,
    onLanguagesChange,
    resolveLanguage,
    SystemLanguage,
    translate,
    translateCount,
} from "./i18n-core";
import "./i18n-locales-lazy";

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
    // The language on screen while a newly chosen one loads (#1213): never a language whose texts are not there yet.
    shownLocaleAtom = jotai.atom<string>(FallbackLanguage) as jotai.PrimitiveAtom<string>;

    resolutionAtom!: jotai.Atom<{ locale: string; unknown: string }>;
    // The resolved language once its dictionary is loaded, the shown one until then.
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
        this.localeAtom = jotai.atom((get) => {
            get(this.languagesVersionAtom);
            const locale = get(this.resolutionAtom).locale;
            return isLanguageReady(locale) ? locale : get(this.shownLocaleAtom);
        });
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
        globalStore.sub(this.resolutionAtom, () => {
            this.whenReady().catch((e) => console.error("loading the interface language", e));
        });
        this.lastLocale = globalStore.get(this.localeAtom);
        setDocumentLang(this.lastLocale);
        this.whenReady().catch((e) => console.error("loading the interface language", e));
    }

    // Resolves once the resolved language's texts are loaded; the app awaits it before its first render, so no raw
    // key ever shows.
    async whenReady(): Promise<void> {
        await loadLanguage(globalStore.get(this.resolutionAtom).locale);
        // English follows without delaying the first render: a key the active language lacks shows its English
        // text rather than the raw key (#1215).
        loadFallbackLanguage().catch((e) => console.error("loading the fallback language", e));
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
        globalStore.set(this.shownLocaleAtom, locale);
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

// "label: value" with the current language's colon spacing (French: no-break space before the colon).
export function labelled(label: string, value: string): string {
    return labelledText(getLocale(), label, value);
}

// The plural form of `key` (`key`.one / `key`.other) for count, by the current language's rule.
export function tCount(key: string, count: number, vars?: I18nVars): string {
    return translateCount(getLocale(), key, count, vars);
}

// A number in the current language's notation, for models and anything outside React; components pass useLocale().
export function formatNumber(value: number, fractionDigits?: number, locale: string = getLocale()): string {
    return formatLocaleNumber(locale, value, fractionDigits);
}

export function useLocale(): string {
    return jotai.useAtomValue(I18nModel.getInstance().localeAtom, { store: globalStore });
}

// Bumped when a dictionary arrives or a pack changes texts: the translate functions change with it, so a component
// shows texts loaded after its first render (#1213).
function useLanguagesVersion(): number {
    return jotai.useAtomValue(I18nModel.getInstance().languagesVersionAtom, { store: globalStore });
}

// The translate function of the current language; the component renders again when the language changes.
export function useT(): TFunction {
    const locale = useLocale();
    const version = useLanguagesVersion();
    return useCallback((key: string, vars?: I18nVars) => translate(locale, key, vars), [locale, version]);
}

// tCount for components: renders again when the language changes.
export function useTCount(): (key: string, count: number, vars?: I18nVars) => string {
    const locale = useLocale();
    const version = useLanguagesVersion();
    return useCallback(
        (key: string, count: number, vars?: I18nVars) => translateCount(locale, key, count, vars),
        [locale, version]
    );
}
