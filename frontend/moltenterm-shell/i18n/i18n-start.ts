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

type I18nApi = {
    moltentermSystemLanguages?: () => string[];
    moltentermSetLocale?: (locale: string) => void;
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
    const sendLocale = () => {
        const api = getApi() as unknown as I18nApi;
        api?.moltentermSetLocale?.(model.getLocale());
        const unknown = globalStore.get(model.resolutionAtom).unknown;
        if (unknown) reportUnknownLanguage(unknown);
    };
    sendLocale();
    globalStore.sub(model.resolutionAtom, sendLocale);
}
