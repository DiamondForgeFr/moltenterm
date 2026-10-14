// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Language packs (FR-I18N-002, DS-I18N-008, DS-I18N-010): the dictionary a data-only mod brings, checked against
// English. The same function answers `molten i18n check` and the mod host's load, so the agent that writes a pack
// sees the verdict MoltenTerm applies. A pack is data: it is parsed as JSON, never evaluated, and its values are shown
// as text.

import { Dictionary, flattenKeys, placeholders, resolveKey } from "./i18n-core";

// A BCP 47 primary language subtag, optionally with a region (es, pt-br, es-419).
const LanguageCodePattern = /^[a-z]{2,3}(-([a-z]{2}|[0-9]{3}))?$/;

export type LanguagePackProblem = { key: string; message: string };

export type LanguagePackCheck = {
    code: string;
    ok: boolean;
    // A placeholder that differs from English, a value that is not text: the whole pack is refused.
    errors: LanguagePackProblem[];
    // Keys English does not know: ignored.
    warnings: LanguagePackProblem[];
    // English keys the pack does not translate (absent or empty): they show English.
    missing: string[];
    translated: number;
    total: number;
    // The pack without its ignored keys, ready to register; null when refused.
    dict: Dictionary;
};

export function normalizeLanguageCode(code: string): string {
    return typeof code === "string" ? code.trim().toLowerCase().replace(/_/g, "-") : "";
}

export function isLanguageCode(code: string): boolean {
    return LanguageCodePattern.test(normalizeLanguageCode(code));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function setKey(dict: Dictionary, key: string, value: string) {
    const parts = key.split(".");
    let cursor = dict;
    for (const part of parts.slice(0, -1)) {
        if (!isPlainObject(cursor[part])) cursor[part] = {};
        cursor = cursor[part] as Dictionary;
    }
    cursor[parts[parts.length - 1]] = value;
}

function describePlaceholders(names: string[]): string {
    return names.map((n) => `{${n}}`).join(", ");
}

// Walks the pack: leaves that are not strings are errors, string leaves are collected by dotted key.
function collectLeaves(value: unknown, prefix: string, out: Map<string, string>, errors: LanguagePackProblem[]) {
    if (!isPlainObject(value)) {
        errors.push({ key: prefix, message: `"${prefix}" must be a string or an object of strings` });
        return;
    }
    for (const [name, child] of Object.entries(value)) {
        const key = prefix ? `${prefix}.${name}` : name;
        if (typeof child === "string") {
            out.set(key, child);
            continue;
        }
        collectLeaves(child, key, out, errors);
    }
}

export function checkLanguagePack(code: string, pack: unknown, english: Dictionary): LanguagePackCheck {
    const normalized = normalizeLanguageCode(code);
    const englishKeys = flattenKeys(english);
    const result: LanguagePackCheck = {
        code: normalized,
        ok: false,
        errors: [],
        warnings: [],
        missing: [],
        translated: 0,
        total: englishKeys.length,
        dict: null,
    };
    if (!isLanguageCode(normalized)) {
        result.errors.push({
            key: "",
            message: `"${code}" is not a language code: use a BCP 47 primary subtag, optionally with a region (es, pt-br)`,
        });
    }
    if (!isPlainObject(pack)) {
        result.errors.push({ key: "", message: "a language pack must be a JSON object of keys" });
        result.missing = englishKeys;
        return result;
    }
    const leaves = new Map<string, string>();
    collectLeaves(pack, "", leaves, result.errors);
    const cleaned: Dictionary = {};
    for (const [key, value] of [...leaves.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const reference = resolveKey(english, key);
        if (reference == null) {
            result.warnings.push({ key, message: `"${key}" is not an English key: ignored` });
            continue;
        }
        if (value === "") continue;
        const expected = placeholders(reference);
        const found = placeholders(value);
        const lacking = expected.filter((p) => !found.includes(p));
        const extra = found.filter((p) => !expected.includes(p));
        if (lacking.length > 0 || extra.length > 0) {
            const parts: string[] = [];
            if (lacking.length > 0) parts.push(`placeholder ${describePlaceholders(lacking)} is missing`);
            if (extra.length > 0) parts.push(`placeholder ${describePlaceholders(extra)} is not in English`);
            result.errors.push({
                key,
                message: `"${key}": ${parts.join("; ")} (English: ${describePlaceholders(expected) || "no placeholder"})`,
            });
            continue;
        }
        setKey(cleaned, key, value);
    }
    result.missing = englishKeys.filter((key) => {
        const value = leaves.get(key);
        return value == null || value === "";
    });
    result.translated = result.total - result.missing.length;
    result.ok = result.errors.length === 0;
    result.dict = result.ok ? cleaned : null;
    return result;
}

// The English keys a language lacks once its packs are applied, for the untranslated notice and `molten i18n status`.
export function missingKeys(english: Dictionary, lookup: (key: string) => string | undefined): string[] {
    return flattenKeys(english).filter((key) => lookup(key) == null);
}

// The English entries of some keys, shaped as a pack, for `molten i18n export`.
export function pickKeys(source: Dictionary, keys: string[]): Dictionary {
    const out: Dictionary = {};
    for (const key of keys) {
        const value = resolveKey(source, key);
        if (value != null) setKey(out, key, value);
    }
    return out;
}

export function formatPackProblems(check: LanguagePackCheck): string {
    return check.errors.map((e) => e.message).join("\n");
}
