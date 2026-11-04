// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The search engine of every place that searches the web with typed words (#1748): the browser panel's address bar,
// the sidebar's top field and the panel launcher, like Wave's web view. One setting, web:defaultsearch, read at each
// search, so a change in the settings screen, settings.json or `wsh setconfig` applies without a restart.

// global-atoms, not global: browser-model imports this file, and global's graph leads back to browser-model through the
// carpet's radar, so importing global here left MoltentermBrowserView undefined in the modules loaded meanwhile.
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";

export const DefaultSearchSettingKey = "web:defaultsearch";
// Must match web:defaultsearch in pkg/wconfig/defaultconfig/settings.json.
export const DefaultSearchTemplate = "https://www.google.com/search?q={query}";

// {query} is the setting's placeholder (the settings screen documents it); %s, the one the browser panel used before
// #1748, is still understood so a template written that way keeps working.
const QueryPlaceholderRe = /\{query\}|%s/g;

// The web:defaultsearch setting as it is now; null before the settings are loaded (and in unit tests, where the global
// atoms are never initialised).
export function webSearchTemplate(): string {
    const settingsAtom = atoms?.settingsAtom;
    if (settingsAtom == null) {
        return null;
    }
    const value = (globalStore.get(settingsAtom) as Record<string, unknown>)?.[DefaultSearchSettingKey];
    return typeof value === "string" ? value : null;
}

// The search URL of words. A template that cannot carry the words (empty, or without a placeholder) would drop them,
// so the default engine searches instead.
export function searchUrl(words: string, template: string): string {
    const usable = typeof template === "string" && template.trim() !== "" && /\{query\}|%s/.test(template);
    const encoded = encodeURIComponent(words);
    return (usable ? template.trim() : DefaultSearchTemplate).replace(QueryPlaceholderRe, () => encoded);
}
