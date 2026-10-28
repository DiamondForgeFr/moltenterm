// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's shipped dictionaries, each its own chunk loaded on demand (#1213, NFR-PERF-003): the startup bundle
// carries none, the app awaits the active language before its first render and loads another when it is chosen.

import { LocaleUpdateEvent } from "../build/locales-hot";
import { Dictionary, provideShippedLanguages, replaceShippedDictionary } from "./i18n-core";

provideShippedLanguages(
    import.meta.glob("./locales/*.json", { import: "default" }) as unknown as Record<string, () => Promise<Dictionary>>
);

// Under the dev server a dictionary file changed since the views loaded it (a pull, an edit) is fetched again and
// replaces the texts on screen, so a key added meanwhile never shows raw (#1215). A new URL each time: the browser
// keeps the module it already imported.
async function reloadShippedDictionary(code: string) {
    const url = new URL(`./locales/${code}.json`, import.meta.url);
    const mod = await import(/* @vite-ignore */ `${url.pathname}?import&t=${Date.now()}`);
    replaceShippedDictionary(code, mod?.default as Dictionary);
}

if (import.meta.hot) {
    import.meta.hot.on(LocaleUpdateEvent, (data: { code?: string }) => {
        if (!data?.code) return;
        reloadShippedDictionary(data.code).catch((e) =>
            console.error("reloading the interface language", data.code, e)
        );
    });
}
