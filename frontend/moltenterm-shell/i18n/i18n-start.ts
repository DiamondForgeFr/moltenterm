// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Starts the renderer's interface language (FR-I18N-001, DS-I18N-002): the OS preferred languages from Electron main,
// app:language from the settings atom, live. A value that names no available language resolves as the OS's and is
// reported once in the notification center. The resolved code goes to Electron main, so a language only the renderer
// knows (a language pack, #624) can reach the app menu too.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { addMoltentermNotification } from "../notifications-store";
import { AppLanguageSettingKey, I18nModel, t } from "./i18n";
import { LanguagePackInput, languagePacks } from "./language-packs";

type I18nApi = {
    moltentermSystemLanguages?: () => string[];
    moltentermSetLocale?: (locale: string) => void;
    moltentermSetLanguagePacks?: (packs: LanguagePackInput[]) => void;
};

let started = false;
const reportedUnknown = new Set<string>();

function readSystemLanguages(): string[] {
    try {
        const api = getApi() as unknown as I18nApi;
        return api?.moltentermSystemLanguages?.() ?? [];
    } catch {
        return [];
    }
}

function reportUnknownLanguage(value: string) {
    if (!value || reportedUnknown.has(value)) return;
    reportedUnknown.add(value);
    addMoltentermNotification({
        key: `i18n:unknownlanguage:${value}`,
        source: "moltenterm",
        kind: "warning",
        global: true,
        title: t("i18n.unknownLanguage.title", { value }),
        message: t("i18n.unknownLanguage.message", { value }),
    });
}

export function startMoltentermI18n() {
    if (started) return;
    started = true;
    const model = I18nModel.getInstance();
    model.setOsLanguages(readSystemLanguages());
    const applySetting = () => {
        const settings = globalStore.get(atoms.settingsAtom) as Record<string, unknown>;
        const value = settings?.[AppLanguageSettingKey];
        model.setLanguageSetting(typeof value === "string" ? value : "");
    };
    applySetting();
    globalStore.sub(atoms.settingsAtom, applySetting);
    const packs = languagePacks();
    const sendLocale = () => {
        const api = getApi() as unknown as I18nApi;
        api?.moltentermSetLocale?.(model.getLocale());
        // A pack's language is unknown until the mod host handed the packs over (FR-I18N-002).
        const unknown = globalStore.get(model.resolutionAtom).unknown;
        if (unknown && packs.loaded) reportUnknownLanguage(unknown);
    };
    // Main gets the packs' dictionaries before the code, so the app menu can speak a pack's language.
    const sendPacks = () => {
        const api = getApi() as unknown as I18nApi;
        api?.moltentermSetLanguagePacks?.(
            packs.activePacks().map((p) => ({ modId: p.modId, code: p.code, name: p.name, dict: p.dict }))
        );
        sendLocale();
    };
    sendLocale();
    globalStore.sub(model.resolutionAtom, sendLocale);
    packs.onChange(sendPacks);
}
