// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The untranslated strings notice (FR-I18N-002, DS-I18N-011) and the report of a pack that lost its code to another.
// When the interface speaks a language a pack added and that pack lacks English keys (an update added some), one
// notification says how many, with an action that copies the ready /morph request completing it. Shown once per
// MoltenTerm version and language: the versions already told are kept in the client meta, shared by every window.

import { ClientModel } from "@/app/store/client-model";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { completeLanguageRequest } from "../../molten/morph-templates";
import {
    addMoltentermNotification,
    MoltentermNotifications,
    registerNotificationGesture,
    resolveMoltentermNotification,
} from "../notifications-store";
import { I18nModel, t } from "./i18n";
import { isShippedLanguage, languageName } from "./i18n-core";
import { untranslatedCount } from "./language-pack-tools";
import { languagePacks } from "./language-packs";

export const UntranslatedNoticeMetaKey = "moltenterm:i18nnotice";
export const CopyMorphRequestGesture = "morph:copy-request";

let started = false;
const reportedShadowed = new Set<string>();

export function untranslatedNoticeKey(code: string): string {
    return `i18n:untranslated:${code}`;
}

// Whether the notice is due: a pack's own language, strings missing, and not told yet for this version.
export function noticeDue(
    code: string,
    count: number,
    version: string,
    told: Record<string, string>,
    fromPack: boolean
): boolean {
    if (!fromPack || isShippedLanguage(code) || count <= 0) return false;
    return told?.[code] !== version;
}

function toldVersions(): Record<string, string> {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const value = clientAtom == null ? null : (globalStore.get(clientAtom)?.meta as any)?.[UntranslatedNoticeMetaKey];
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function appVersion(): string {
    try {
        return getApi().getAboutModalDetails()?.version ?? "";
    } catch {
        return "";
    }
}

function checkUntranslated() {
    const packs = languagePacks();
    if (!packs.loaded) return;
    const code = I18nModel.getInstance().getLocale();
    const fromPack = packs.sourceOf(code) != null && !isShippedLanguage(code);
    if (!fromPack) return;
    const count = untranslatedCount(code);
    if (count === 0) {
        resolveMoltentermNotification(untranslatedNoticeKey(code));
        return;
    }
    const version = appVersion();
    const told = toldVersions();
    if (!noticeDue(code, count, version, told, fromPack)) return;
    MoltentermNotifications.getInstance().write({ [UntranslatedNoticeMetaKey]: { ...told, [code]: version } });
    const language = languageName(code);
    addMoltentermNotification({
        key: untranslatedNoticeKey(code),
        source: "moltenterm",
        kind: "info",
        global: true,
        title: t("i18n.untranslated.title", { count, language }),
        message: t("i18n.untranslated.message", { language }),
        actions: [
            {
                id: "copy-morph",
                label: t("i18n.untranslated.copy"),
                kind: "gesture",
                gesture: CopyMorphRequestGesture,
                args: { request: completeLanguageRequest(language, code) },
                lasting: true,
            },
        ],
    });
}

function reportShadowed() {
    for (const s of languagePacks().shadowed) {
        const id = `${s.modId}:${s.code}:${s.by}`;
        if (reportedShadowed.has(id)) continue;
        reportedShadowed.add(id);
        addMoltentermNotification({
            key: `i18n:shadowed:${s.code}`,
            source: "mod",
            kind: "warning",
            global: true,
            title: t("i18n.shadowed.title", { language: languageName(s.code) }),
            message: t("i18n.shadowed.message", { mod: s.modId, by: s.by, code: s.code }),
        });
    }
}

// Started with the mod host: only a view that runs the host knows the packs.
export function startLanguagePackNotice() {
    if (started) return;
    started = true;
    registerNotificationGesture(CopyMorphRequestGesture, async (args) => {
        const request = typeof args?.request === "string" ? args.request : "";
        if (!request) return { ok: false, error: "no request to copy" };
        await navigator.clipboard.writeText(request);
        return { ok: true };
    });
    const check = () => {
        try {
            checkUntranslated();
            reportShadowed();
        } catch (e) {
            console.error("language pack notice", e);
        }
    };
    languagePacks().onChange(check);
    globalStore.sub(I18nModel.getInstance().localeAtom, check);
}
