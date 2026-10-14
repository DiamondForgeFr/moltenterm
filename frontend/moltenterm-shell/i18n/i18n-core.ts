// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Interface languages (FR-I18N-001, DS-I18N-001, DS-I18N-002): the dictionaries, key resolution and the language
// resolution, without React or Jotai so Electron main uses the same rules as the renderer. Pattern from Notulia
// (src/lib/i18n-utils.ts), with single-brace placeholders.
//
// A language is a nested dictionary addressed by dotted keys. English is the reference and the fallback: a key the
// active language lacks shows the English text. Adding a language is adding one dictionary file next to en.json, named
// after its code, with no code change: its `language.name` is the language's own name, as the picker shows it. A
// language pack mod (#624, DS-I18N-008) registers its dictionary at run time through registerLanguage, either a new
// code or per-key overrides of a shipped one.

export type Dictionary = { [key: string]: string | Dictionary };
export type I18nVars = Record<string, string | number>;

export const FallbackLanguage = "en";
export const SystemLanguage = "system";

export type LanguageInfo = { code: string; name: string };

type LanguageEntry = LanguageInfo & { dict: Dictionary; overrides: Dictionary[] };

const LocaleFiles = import.meta.glob("./locales/*.json", { eager: true, import: "default" }) as unknown as Record<
    string,
    Dictionary
>;

function shippedLanguages(): LanguageEntry[] {
    const entries = Object.entries(LocaleFiles).map(([path, dict]) => {
        const code = path
            .replace(/^.*\//, "")
            .replace(/\.json$/, "")
            .toLowerCase();
        return { code, name: resolveKey(dict, "language.name") ?? code, dict, overrides: [] as Dictionary[] };
    });
    // English first: it is the reference and the fallback.
    return entries.sort((a, b) => (a.code === FallbackLanguage ? -1 : b.code === FallbackLanguage ? 1 : 0));
}

const ShippedLanguages: LanguageEntry[] = shippedLanguages();

const languages = new Map<string, LanguageEntry>(ShippedLanguages.map((l) => [l.code, { ...l, overrides: [] }]));
const listeners = new Set<() => void>();

// Resolves a dotted key (`a.b.c`) against a nested dictionary; undefined when absent or empty (an empty string counts
// as missing, so the English text shows instead: no visible string is ever empty, NFR-I18N-003).
export function resolveKey(dict: Dictionary, key: string): string | undefined {
    if (dict == null || !key) return undefined;
    let cursor: string | Dictionary = dict;
    for (const part of key.split(".")) {
        if (cursor == null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part))
            return undefined;
        cursor = cursor[part];
    }
    return typeof cursor === "string" && cursor !== "" ? cursor : undefined;
}

// Fills `{name}` placeholders. An unknown placeholder is left intact. Values are plain text: callers render the result
// as text, never as HTML.
export function interpolate(template: string, vars?: I18nVars): string {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const value = vars[name];
        return value == null ? whole : String(value);
    });
}

// The placeholder names of a template, for the dictionary checks.
export function placeholders(template: string): string[] {
    return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

// Every dotted key of a dictionary that holds a string.
export function flattenKeys(dict: Dictionary, prefix = ""): string[] {
    const keys: string[] = [];
    for (const [name, value] of Object.entries(dict ?? {})) {
        const key = prefix ? `${prefix}.${name}` : name;
        if (typeof value === "string") keys.push(key);
        else if (value != null && typeof value === "object") keys.push(...flattenKeys(value, key));
    }
    return keys;
}

// #860 of Notulia: the language when none was chosen. `preferred` is the OS list, most preferred first
// (["fr-FR", "en-US"]). The first language MoltenTerm speaks wins, matched on the primary subtag (fr-CA and fr-FR give
// French), in preference order: someone who reads German first and English second gets English, not French.
export function preferredLocale(preferred: readonly string[], supported: readonly string[], fallback: string): string {
    for (const tag of preferred ?? []) {
        if (typeof tag !== "string") continue;
        const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
        if (primary && supported.includes(primary)) return primary;
    }
    return fallback;
}

export function normalizeLanguageSetting(value: unknown): string {
    if (typeof value !== "string") return SystemLanguage;
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" ? SystemLanguage : trimmed;
}

export type LanguageResolution = {
    locale: string;
    // The app:language value that names no available language (it resolves as system), "" otherwise.
    unknown: string;
};

// The interface language: the explicit app:language when MoltenTerm has it, else the OS's first spoken language.
export function resolveLanguage(
    setting: unknown,
    osLanguages: readonly string[],
    available: readonly string[] = availableLanguageCodes()
): LanguageResolution {
    const explicit = normalizeLanguageSetting(setting);
    const fromOs = preferredLocale(osLanguages, available, FallbackLanguage);
    if (explicit === SystemLanguage) return { locale: fromOs, unknown: "" };
    if (available.includes(explicit)) return { locale: explicit, unknown: "" };
    return { locale: fromOs, unknown: explicit };
}

export function availableLanguages(): LanguageInfo[] {
    return [...languages.values()].map(({ code, name }) => ({ code, name }));
}

export function availableLanguageCodes(): string[] {
    return [...languages.keys()];
}

export function languageName(code: string): string {
    return languages.get(code)?.name ?? code;
}

// A language added at run time (#624): a new code becomes a full language falling back to English; a known code gets
// per-key overrides over its dictionary. Returns the function that removes it again.
export function registerLanguage(info: LanguageInfo, dict: Dictionary): () => void {
    const code = info.code.trim().toLowerCase();
    const existing = languages.get(code);
    if (existing) {
        existing.overrides.push(dict);
        notify();
        return () => {
            existing.overrides = existing.overrides.filter((d) => d !== dict);
            notify();
        };
    }
    const entry: LanguageEntry = { code, name: info.name || code, dict, overrides: [] };
    languages.set(code, entry);
    notify();
    return () => {
        if (languages.get(code) === entry) languages.delete(code);
        notify();
    };
}

// Called when the set of languages or their texts change, so the resolved language and the views refresh.
export function onLanguagesChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let batchDepth = 0;
let batchChanged = false;

// Runs several registrations as one change: listeners hear once, after the last, so a pack replaced by a newer
// version never shows a moment where its language is missing (the views would flash and app:language would read as
// unknown).
export function batchLanguageChanges(fn: () => void) {
    batchDepth++;
    try {
        fn();
    } finally {
        batchDepth--;
        if (batchDepth === 0 && batchChanged) {
            batchChanged = false;
            notify();
        }
    }
}

function notify() {
    if (batchDepth > 0) {
        batchChanged = true;
        return;
    }
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (e) {
            console.error("i18n listener", e);
        }
    }
}

function lookup(code: string, key: string): string | undefined {
    const entry = languages.get(code);
    if (entry == null) return undefined;
    for (let i = entry.overrides.length - 1; i >= 0; i--) {
        const value = resolveKey(entry.overrides[i], key);
        if (value != null) return value;
    }
    return resolveKey(entry.dict, key);
}

// The text of `key` in `locale`: the active language, then English, then the key itself (a missing key is caught by
// the dictionary test before release, NFR-I18N-003).
export function translate(locale: string, key: string, vars?: I18nVars): string {
    const text = lookup(locale, key) ?? lookup(FallbackLanguage, key);
    if (text == null) return key;
    return interpolate(text, vars);
}

// The text of `key` in `code` alone, packs included, without falling back to English.
export function languageText(code: string, key: string): string | undefined {
    return lookup(code, key);
}

export function isShippedLanguage(code: string): boolean {
    return ShippedLanguages.some((l) => l.code === code);
}

export function hasKey(key: string): boolean {
    return lookup(FallbackLanguage, key) != null;
}

// The shipped dictionary of a language (tests and tools; packs are not merged in).
export function shippedDictionary(code: string): Dictionary {
    return ShippedLanguages.find((l) => l.code === code)?.dict;
}
