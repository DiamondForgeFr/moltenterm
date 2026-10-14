// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What `molten i18n export | check | status` answers (FR-I18N-002, DS-I18N-009). The tab computes it, from the same
// dictionaries, packs and checks it applies, and molten prints it in English (DS-I18N-007).

import {
    availableLanguages,
    Dictionary,
    flattenKeys,
    isShippedLanguage,
    languageText,
    placeholders,
    resolveKey,
    shippedDictionary,
} from "./i18n-core";
import { checkLanguagePack, LanguagePackProblem, missingKeys, pickKeys } from "./language-pack";
import { languagePacks } from "./language-packs";

// must match the types in cmd/wsh/cmd/wshcmd-molten-i18n.go
export type I18nLanguageStatus = {
    code: string;
    name: string;
    shipped: boolean;
    // The language pack that gives the language, or overrides texts of a shipped one.
    pack?: string;
    untranslated: number;
    total: number;
};

export type I18nRefusedPack = { id: string; state: string; error: string };

export type I18nStatus = {
    active: string;
    languages: I18nLanguageStatus[];
    shadowed: { modid: string; code: string; by: string }[];
    refused: I18nRefusedPack[];
};

export type I18nExportKey = { key: string; english: string; placeholders: string[]; translation?: string };

export type I18nExport = {
    language?: string;
    missing: boolean;
    count: number;
    // Shaped as a pack file, in en.json's order.
    dict: Dictionary;
    keys: I18nExportKey[];
};

export type I18nCheck = {
    code: string;
    ok: boolean;
    errors: LanguagePackProblem[];
    warnings: LanguagePackProblem[];
    missing: number;
    translated: number;
    total: number;
};

function english(): Dictionary {
    return shippedDictionary("en");
}

export function untranslatedCount(code: string): number {
    if (code === "en") return 0;
    return missingKeys(english(), (key) => languageText(code, key)).length;
}

export function i18nStatus(active: string, refused: I18nRefusedPack[] = []): I18nStatus {
    const total = flattenKeys(english()).length;
    const packs = languagePacks();
    return {
        active,
        languages: availableLanguages().map(({ code, name }) => {
            const pack = packs.sourceOf(code);
            return {
                code,
                name,
                shipped: isShippedLanguage(code),
                ...(pack != null ? { pack } : {}),
                untranslated: untranslatedCount(code),
                total,
            };
        }),
        shadowed: packs.shadowed.map((s) => ({ modid: s.modId, code: s.code, by: s.by })),
        refused,
    };
}

export class I18nToolError extends Error {}

export function i18nExport(language: string, onlyMissing: boolean): I18nExport {
    const code = (language ?? "").trim().toLowerCase();
    if (onlyMissing && !code) {
        throw new I18nToolError("--missing needs --lang <code>");
    }
    const known = availableLanguages().map((l) => l.code);
    const keysOf = flattenKeys(english());
    const out: I18nExport = { missing: onlyMissing, count: 0, dict: {}, keys: [] };
    if (code) {
        out.language = code;
    }
    let keys = keysOf;
    if (code && known.includes(code) && onlyMissing) {
        keys = keysOf.filter((key) => languageText(code, key) == null);
    } else if (code && !known.includes(code) && !onlyMissing) {
        throw new I18nToolError(
            `no language "${code}" is installed (installed: ${known.join(", ")}); use --missing to export every key to translate`
        );
    }
    const translated = code && known.includes(code);
    for (const key of keys) {
        const text = resolveKey(english(), key);
        const entry: I18nExportKey = { key, english: text, placeholders: placeholders(text) };
        if (translated) {
            const translation = languageText(code, key);
            if (translation != null) entry.translation = translation;
        }
        out.keys.push(entry);
    }
    // Without --lang: the English reference; with --lang: the current translation; with --missing: English to translate.
    out.dict = code && !onlyMissing ? pickTranslation(code, keys) : pickKeys(english(), keys);
    out.count = keys.length;
    return out;
}

function pickTranslation(code: string, keys: string[]): Dictionary {
    const out: Dictionary = {};
    for (const key of keys) {
        const value = languageText(code, key);
        if (value == null) continue;
        const parts = key.split(".");
        let cursor = out;
        for (const part of parts.slice(0, -1)) {
            if (cursor[part] == null || typeof cursor[part] !== "object") cursor[part] = {};
            cursor = cursor[part] as Dictionary;
        }
        cursor[parts[parts.length - 1]] = value;
    }
    return out;
}

export function i18nCheck(code: string, text: string): I18nCheck {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return {
            code,
            ok: false,
            errors: [{ key: "", message: `not valid JSON: ${String((e as Error)?.message ?? e)}` }],
            warnings: [],
            missing: 0,
            translated: 0,
            total: flattenKeys(english()).length,
        };
    }
    const check = checkLanguagePack(code, data, english());
    return {
        code: check.code,
        ok: check.ok,
        errors: check.errors,
        warnings: check.warnings,
        missing: check.missing.length,
        translated: check.translated,
        total: check.total,
    };
}
