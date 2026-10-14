// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Electron main's interface language (FR-I18N-001, DS-I18N-002, DS-I18N-003): the app menu, the dock menu, the menu
// entries MoltenTerm adds and the native dialogs follow app:language, resolved with the same rules and dictionaries as
// the renderer (frontend/moltenterm-shell/i18n/i18n-core.ts). The OS preferred languages come from
// app.getPreferredSystemLanguages(), never from the bundle's localizations; they go to the renderers through IPC, and
// the language picked from them to wavesrv through MOLTENTERM_SYSTEM_LANGUAGE (review:language's default,
// DS-I18N-006). A renderer's resolved code is
// taken when main has that language (a pack the renderer registered and forwarded, #624).

import { waveEventSubscribeSingle } from "@/app/store/wps";
import * as electron from "electron";
import {
    availableLanguageCodes,
    FallbackLanguage,
    I18nVars,
    resolveLanguage,
    SystemLanguage,
    translate,
} from "../frontend/moltenterm-shell/i18n/i18n-core";
import { LanguagePackInput, LanguagePackRegistry } from "../frontend/moltenterm-shell/i18n/language-packs";

export const MoltentermSystemLanguageVarName = "MOLTENTERM_SYSTEM_LANGUAGE";
export const SystemLanguagesChannel = "moltenterm-system-languages";
export const SetLocaleChannel = "moltenterm-set-locale";
export const SetLanguagePacksChannel = "moltenterm-set-language-packs";

// The packs the renderer forwards (#624): the renderer already chose one pack per code and checked it, so main only
// registers them. Every renderer sends the same set; the last one sent is kept.
const mainPacks = new LanguagePackRegistry();

function isForwardedPack(value: any): value is LanguagePackInput {
    return (
        value != null &&
        typeof value.modId === "string" &&
        typeof value.code === "string" &&
        typeof value.name === "string" &&
        value.dict != null &&
        typeof value.dict === "object"
    );
}

let languageSetting: unknown = null;
let rendererLocale: string = null;
let currentLocale = FallbackLanguage;
let osLanguages: string[] = null;
const changeListeners = new Set<(locale: string) => void>();

export function systemLanguages(): string[] {
    if (osLanguages != null) return osLanguages;
    try {
        const list = electron.app.getPreferredSystemLanguages();
        const languages = Array.isArray(list) ? list.filter((l) => typeof l === "string" && l !== "") : [];
        // An empty answer (asked too early) is not kept: the next call asks again.
        if (languages.length > 0) osLanguages = languages;
        return languages;
    } catch (e) {
        console.log("getPreferredSystemLanguages failed", e);
        return [];
    }
}

// The text of a key in main's current language.
export function mt(key: string, vars?: I18nVars): string {
    return translate(currentLocale, key, vars);
}

export function mainLocale(): string {
    return currentLocale;
}

export function onMainLocaleChange(listener: (locale: string) => void): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

function recompute() {
    const available = availableLanguageCodes();
    let next = resolveLanguage(languageSetting, systemLanguages(), available).locale;
    if (rendererLocale != null && rendererLocale !== next && available.includes(rendererLocale)) {
        next = rendererLocale;
    }
    if (next === currentLocale) return;
    currentLocale = next;
    console.log("moltenterm interface language", currentLocale);
    for (const listener of [...changeListeners]) {
        try {
            listener(currentLocale);
        } catch (e) {
            console.log("locale listener error", e);
        }
    }
}

export function noteLanguageSetting(settings: Record<string, unknown>) {
    if (settings == null) return;
    const value = settings["app:language"] ?? null;
    if (value === languageSetting) return;
    languageSetting = value;
    rendererLocale = null;
    recompute();
}

// Before wavesrv starts: its review session takes the language MoltenTerm picks from the OS as review:language's
// default when app:language is unset (pkg/molten/i18nlang).
export function exportSystemLanguageToEnv() {
    process.env[MoltentermSystemLanguageVarName] = resolveLanguage(SystemLanguage, systemLanguages()).locale;
}

// After wshrpc is up: the first settings, then every config event; the IPC the renderers use.
export function initMoltentermI18n(fullConfig: FullConfigType) {
    noteLanguageSetting(fullConfig?.settings as Record<string, unknown>);
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: FullConfigType })?.fullconfig?.settings;
            noteLanguageSetting(settings as Record<string, unknown>);
        },
    });
}

export function initMoltentermI18nIpc() {
    electron.ipcMain.on(SystemLanguagesChannel, (event) => {
        event.returnValue = systemLanguages();
    });
    electron.ipcMain.on(SetLanguagePacksChannel, (_event, packs: unknown) => {
        if (!Array.isArray(packs)) return;
        mainPacks.apply(packs.filter(isForwardedPack).map((p) => ({ ...p, enabledAt: 0 })));
        recompute();
    });
    electron.ipcMain.on(SetLocaleChannel, (_event, locale: unknown) => {
        if (typeof locale !== "string" || locale === "") return;
        rendererLocale = locale;
        recompute();
    });
}
