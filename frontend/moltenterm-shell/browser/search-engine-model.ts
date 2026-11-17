// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the search engine (#1748, #2312), pure so the settings, the chooser and the browser panel's menu share
// them without the app's stores: the presets, which preset a template is, the search URL of words, and when the note
// about the default engine is due. search-engine.ts reads the setting and re-exports this.

export const DefaultSearchSettingKey = "web:defaultsearch";
// The hidden setting that remembers the note about the default engine was shown (#2312).
export const SearchEngineNoteKey = "moltenterm:searchenginenote";
// The default engine is the recommended one. Must match web:defaultsearch in pkg/wconfig/defaultconfig/settings.json:
// a user whose settings.json has no such key (a new install, or one who never chose) searches with it, and a value the
// user wrote is never replaced.
export const DefaultSearchTemplate = "https://search.brave.com/search?q={query}";

// {query} is the setting's placeholder (the settings screen documents it); %s, the one the browser panel used before
// #1748, is still understood so a template written that way keeps working.
const QueryPlaceholderRe = /\{query\}|%s/g;
const HasPlaceholderRe = /\{query\}|%s/;

// A preset engine (#2312). The name is the engine's own, so it is not translated; the one line saying how it treats
// privacy is (settings.searchEngine.<id>). The mark is its letters on a neutral tile, drawn with the shell's tokens:
// showing the list makes no network call (no favicon is fetched).
export type SearchEnginePreset = {
    id: string;
    name: string;
    template: string;
    letter: string;
};

export const RecommendedEngineId = "brave";
export const CustomEngineId = "custom";

export const SearchEnginePresets: SearchEnginePreset[] = [
    { id: "brave", name: "Brave Search", template: DefaultSearchTemplate, letter: "Br" },
    { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q={query}", letter: "D" },
    { id: "startpage", name: "Startpage", template: "https://www.startpage.com/sp/search?query={query}", letter: "S" },
    { id: "qwant", name: "Qwant", template: "https://www.qwant.com/?q={query}", letter: "Q" },
    { id: "ecosia", name: "Ecosia", template: "https://www.ecosia.org/search?q={query}", letter: "E" },
    { id: "google", name: "Google", template: "https://www.google.com/search?q={query}", letter: "G" },
    { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={query}", letter: "Bi" },
];

// What shows of the engine a search will use: a preset, or the custom template under the name of its site.
export type SearchEngineInfo = {
    id: string;
    name: string;
    letter: string;
};

// A template as stored, ready to compare: trimmed, with the legacy %s read as {query}.
function normalized(template: string): string {
    return (template ?? "").trim().replace(/%s/g, "{query}");
}

// A template that cannot carry the words (empty, or without a placeholder) would drop them: the default engine
// searches instead.
export function usableTemplate(template: string): boolean {
    return typeof template === "string" && template.trim() !== "" && HasPlaceholderRe.test(template);
}

// The template a search uses.
export function effectiveTemplate(template: string): string {
    return usableTemplate(template) ? template.trim() : DefaultSearchTemplate;
}

// The preset a template is, or null for a custom one.
export function presetOf(template: string): SearchEnginePreset {
    const wanted = normalized(template);
    return SearchEnginePresets.find((p) => p.template === wanted) ?? null;
}

function hostOfTemplate(template: string): string {
    try {
        return new URL(normalized(template).replace(/\{query\}/g, "q")).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

// The engine a template stands for, the default one when the template is not usable, like the search itself.
export function searchEngineInfo(template: string): SearchEngineInfo {
    const effective = effectiveTemplate(template);
    const preset = presetOf(effective);
    if (preset != null) {
        return { id: preset.id, name: preset.name, letter: preset.letter };
    }
    const host = hostOfTemplate(effective);
    return { id: CustomEngineId, name: host, letter: /^[a-z]/i.test(host) ? host[0].toUpperCase() : "…" };
}

// The search URL of words.
export function searchUrl(words: string, template: string): string {
    const encoded = encodeURIComponent(words);
    return effectiveTemplate(template).replace(QueryPlaceholderRe, () => encoded);
}

// Whether a page is a search of the engine: its address starts as the template does, up to the words.
export function isSearchPage(url: string, template: string): boolean {
    const effective = effectiveTemplate(template);
    const prefix = effective.slice(0, effective.search(HasPlaceholderRe));
    return prefix !== "" && (url ?? "").startsWith(prefix);
}

// Whether the note about the default engine is due (#2312): the engine is the one every user who never chose gets, and
// the note was not shown yet. A user who chose another engine, Google included, is never told about the default.
export function searchNoteDue(template: string, shown: unknown): boolean {
    return shown !== true && presetOf(effectiveTemplate(template))?.id === RecommendedEngineId;
}
