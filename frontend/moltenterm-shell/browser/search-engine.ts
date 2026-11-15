// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The search engine of every place that searches the web with typed words (#1748): the browser panel's address bar,
// the sidebar's top field, the panel launcher and the new view and panel chooser (#2312). One setting,
// web:defaultsearch, read at each search, so a change in the settings screen, settings.json or `wsh setconfig` applies
// without a restart. The rules (presets, the search URL) are in search-engine-model.ts, re-exported here.

// global-atoms, not global: browser-model imports this file, and global's graph leads back to browser-model through the
// carpet's radar, so importing global here left MoltentermBrowserView undefined in the modules loaded meanwhile.
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { DefaultSearchSettingKey, searchEngineInfo, SearchEngineInfo } from "./search-engine-model";

export * from "./search-engine-model";

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

// The engine the next search uses.
export function currentSearchEngine(): SearchEngineInfo {
    return searchEngineInfo(webSearchTemplate());
}
