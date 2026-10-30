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

type DictionaryLoader = () => Promise<Dictionary>;

// A shipped dictionary is either loaded or a loader: the renderer loads only the active language at startup (#1213,
// NFR-PERF-003), Electron main and the tests take every dictionary up front (i18n-locales-eager.ts).
export type ShippedLocaleFiles = Record<string, Dictionary | DictionaryLoader>;

type LanguageEntry = LanguageInfo & {
    dict: Dictionary;
    overrides: Dictionary[];
    shipped: boolean;
    load?: DictionaryLoader;
};

const languages = new Map<string, LanguageEntry>();
const listeners = new Set<() => void>();
const pendingLoads = new Map<string, Promise<void>>();

function localeFileCode(path: string): string {
    return path
        .replace(/^.*\//, "")
        .replace(/\.json$/, "")
        .toLowerCase();
}

// The language's own name before its dictionary is loaded ("Français"); its `language.name` replaces it once loaded.
function nativeLanguageName(code: string): string {
    try {
        const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
        if (!name || name === code) return code;
        return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
    } catch {
        return code;
    }
}

function setShippedDictionary(entry: LanguageEntry, dict: Dictionary) {
    entry.dict = dict;
    entry.load = undefined;
    entry.name = resolveKey(dict, "language.name") ?? entry.name;
}

// Declares the shipped languages (the files of locales/, by path). A dictionary already loaded is kept.
export function provideShippedLanguages(files: ShippedLocaleFiles) {
    // English first: it is the reference and the fallback.
    const codes = Object.keys(files).sort((a, b) => {
        const ca = localeFileCode(a);
        const cb = localeFileCode(b);
        return ca === FallbackLanguage ? -1 : cb === FallbackLanguage ? 1 : ca.localeCompare(cb);
    });
    let changed = false;
    for (const path of codes) {
        const code = localeFileCode(path);
        const value = files[path];
        let entry = languages.get(code);
        if (entry == null) {
            entry = { code, name: nativeLanguageName(code), dict: undefined, overrides: [], shipped: true };
            languages.set(code, entry);
            changed = true;
        }
        entry.shipped = true;
        if (entry.dict != null && entry.load == null) continue;
        if (typeof value === "function") {
            entry.load = value as DictionaryLoader;
            continue;
        }
        setShippedDictionary(entry, value);
        changed = true;
    }
    if (changed) notify();
}

export function isLanguageLoaded(code: string): boolean {
    return languages.get(code)?.dict != null;
}

// Whether `code` can be shown without raw keys: its dictionary is loaded and, for a language a pack adds (which falls
// back to English for the keys it lacks), English is too.
export function isLanguageReady(code: string): boolean {
    const entry = languages.get(code);
    if (entry?.dict == null) return false;
    return entry.shipped || isLanguageLoaded(FallbackLanguage);
}

// A dictionary chunk that fails to arrive (a busy dev server, a slow disk) is fetched again before giving up: the
// interface would otherwise show raw keys until the next language change (#1215).
const LoadAttempts = 3;
const LoadRetryMs = 250;

async function loadWithRetry(load: DictionaryLoader): Promise<Dictionary> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await load();
        } catch (e) {
            if (attempt >= LoadAttempts) throw e;
            await new Promise((resolve) => setTimeout(resolve, LoadRetryMs * attempt));
        }
    }
}

function loadShipped(code: string): Promise<void> {
    const entry = languages.get(code);
    if (entry == null || entry.dict != null || entry.load == null) return Promise.resolve();
    let pending = pendingLoads.get(code);
    if (pending != null) return pending;
    const load = entry.load;
    pending = loadWithRetry(load)
        .then((dict) => {
            if (entry.load !== load) return;
            setShippedDictionary(entry, dict);
            notify();
        })
        .finally(() => pendingLoads.delete(code));
    pendingLoads.set(code, pending);
    return pending;
}

// Loads what `code` needs to show (isLanguageReady): its shipped dictionary, and English for a pack's language.
export async function loadLanguage(code: string): Promise<void> {
    const entry = languages.get(code);
    const loads = [loadShipped(code)];
    if (entry != null && !entry.shipped) loads.push(loadShipped(FallbackLanguage));
    await Promise.all(loads);
}

// English, the fallback of a key the active language lacks, without delaying the active language (#1215).
export function loadFallbackLanguage(): Promise<void> {
    return loadShipped(FallbackLanguage);
}

// New texts for a shipped language whose file changed while the app runs (the dev server, #1215). A language not
// loaded yet needs nothing: its next load reads the new file.
export function replaceShippedDictionary(code: string, dict: Dictionary) {
    const entry = languages.get(code);
    if (entry == null || !entry.shipped || entry.dict == null || dict == null) return;
    setShippedDictionary(entry, dict);
    notify();
}

export async function loadShippedLanguages(): Promise<void> {
    await Promise.all([...languages.values()].filter((l) => l.shipped).map((l) => loadShipped(l.code)));
}

// The shipped dictionary of a language, loaded first when it is not yet.
export async function loadShippedDictionary(code: string): Promise<Dictionary> {
    await loadShipped(code);
    return shippedDictionary(code);
}

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

// "label: value" in the language's typography: French sets a no-break space before the colon (U+00A0, the same as the
// dictionary's), so the colon never starts a line.
export function labelled(locale: string, label: string, value: string): string {
    const space = /^fr(-|$)/i.test(locale ?? "") ? " " : "";
    return `${label}${space}: ${value}`;
}

// Fills `{name}` placeholders. An unknown placeholder is left intact. Values are plain text: callers render the result
// as text, never as HTML.
export function interpolate(template: string, vars?: I18nVars, locale?: string): string {
    if (!vars) return template;
    const french = locale != null && /^fr(-|$)/i.test(locale);
    // French elides before a vowel ("d'Espace", "l'agent"): a template says "de {name}" once, and the value decides.
    // Only a vowel triggers it, never an h (mute or aspirated, unknowable here).
    return template.replace(/(?:(?<![\p{L}-])(de|le|la|que)\s)?\{(\w+)\}/giu, (whole, word: string, name: string) => {
        const value = vars[name];
        if (value == null) return whole;
        const text = String(value);
        if (!french || word == null || !/^[aeiouàâäéèêëîïôöùûü]/i.test(text)) {
            return whole.replace(`{${name}}`, () => text);
        }
        const head = word.toLowerCase() === "que" ? "qu" : word.slice(0, 1);
        return `${head}'${text}`;
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
    const entry: LanguageEntry = { code, name: info.name || code, dict, overrides: [], shipped: false };
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
    return interpolate(text, vars, locale);
}

function pluralRules(locale: string): Intl.PluralRules {
    try {
        return new Intl.PluralRules(locale);
    } catch {
        return new Intl.PluralRules(FallbackLanguage);
    }
}

// The text of `key`.one or `key`.other for `count` in `locale`, with {count} set: the language's own plural rule
// picks the form, so French says "0 non lue" where English says "0 unread". Languages with more forms than one and
// other use other for the rest.
export function translateCount(locale: string, key: string, count: number, vars?: I18nVars): string {
    const form = pluralRules(locale).select(count) === "one" ? "one" : "other";
    return translate(locale, `${key}.${form}`, { count, ...vars });
}

// A number in the interface language's notation ("0,5" in French), with exactly `fractionDigits` decimals when given.
export function formatNumber(locale: string, value: number, fractionDigits?: number): string {
    const opts: Intl.NumberFormatOptions =
        fractionDigits == null ? {} : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
    try {
        return new Intl.NumberFormat(locale, opts).format(value);
    } catch {
        return new Intl.NumberFormat(FallbackLanguage, opts).format(value);
    }
}

// The text of `key` in `code` alone, packs included, without falling back to English.
export function languageText(code: string, key: string): string | undefined {
    return lookup(code, key);
}

export function isShippedLanguage(code: string): boolean {
    return languages.get(code)?.shipped === true;
}

// Whether the shipped dictionaries have `key`: English's when loaded, else any loaded one (they all hold every key of
// en.json, TC-I18N-005).
export function hasKey(key: string): boolean {
    if (isLanguageLoaded(FallbackLanguage)) return lookup(FallbackLanguage, key) != null;
    return [...languages.values()].some((l) => l.shipped && resolveKey(l.dict, key) != null);
}

// The shipped dictionary of a language when it is loaded (tests and tools; packs are not merged in).
export function shippedDictionary(code: string): Dictionary {
    const entry = languages.get(code);
    return entry?.shipped ? entry.dict : undefined;
}
