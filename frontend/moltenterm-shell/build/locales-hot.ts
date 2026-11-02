// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The interface dictionaries under the Vite dev server (#1215). The dev watcher ignores JSON files, so a dictionary
// changed while `task dev` runs (a pull, a branch switch, an edit) was served as it was when the server started, and a
// key added since showed raw. The locale files are watched; a change is sent to the renderers, which load the new
// texts in place (i18n-locales-lazy.ts) instead of reloading every tab view.

export const LocaleUpdateEvent = "moltenterm:locale-update";

const LocaleFileRegex = /[\\/]frontend[\\/]moltenterm-shell[\\/]i18n[\\/]locales[\\/]([^\\/]+)\.json$/;

// The language code of a shipped dictionary file, null for any other file.
export function localeFileCode(file: string): string {
    const m = LocaleFileRegex.exec(file ?? "");
    return m ? m[1].toLowerCase() : null;
}

// The dev watcher's JSON rule: every JSON file stays ignored but the shipped dictionaries.
export function ignoredDevJson(file: string): boolean {
    return /\.json$/i.test(file ?? "") && localeFileCode(file) == null;
}

type HotModule = object;
type HotContext = {
    file: string;
    modules: HotModule[];
    server: {
        moduleGraph: { invalidateModule: (m: HotModule) => void };
        ws: { send: (payload: { type: "custom"; event: string; data: unknown }) => void };
    };
};

export function moltentermLocalesHot() {
    return {
        name: "moltenterm-locales-hot",
        apply: "serve" as const,
        handleHotUpdate(ctx: HotContext): HotModule[] | void {
            const code = localeFileCode(ctx.file);
            if (code == null) return;
            for (const m of ctx.modules) {
                ctx.server.moduleGraph.invalidateModule(m);
            }
            ctx.server.ws.send({ type: "custom", event: LocaleUpdateEvent, data: { code } });
            return [];
        },
    };
}
