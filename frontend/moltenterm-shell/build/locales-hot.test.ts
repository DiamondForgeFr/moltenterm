// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ignoredDevJson, LocaleUpdateEvent, localeFileCode, moltentermLocalesHot } from "./locales-hot";

const Fr = "/repo/frontend/moltenterm-shell/i18n/locales/fr.json";

describe("dictionaries under the dev server (#1215)", () => {
    it("watches the shipped dictionaries and ignores every other JSON file", () => {
        expect(localeFileCode(Fr)).toBe("fr");
        expect(localeFileCode("C:\\repo\\frontend\\moltenterm-shell\\i18n\\locales\\en.json")).toBe("en");
        expect(localeFileCode("/repo/package.json")).toBeNull();
        expect(ignoredDevJson(Fr)).toBe(false);
        expect(ignoredDevJson("/repo/package.json")).toBe(true);
        expect(ignoredDevJson("/repo/frontend/app/app.tsx")).toBe(false);
    });

    it("sends a changed dictionary to the views instead of reloading them", () => {
        const invalidated: object[] = [];
        const sent: unknown[] = [];
        const mod = {};
        const ctx = {
            file: Fr,
            modules: [mod],
            server: {
                moduleGraph: { invalidateModule: (m: object) => invalidated.push(m) },
                ws: { send: (payload: unknown) => sent.push(payload) },
            },
        };
        expect(moltentermLocalesHot().handleHotUpdate(ctx)).toEqual([]);
        expect(invalidated).toEqual([mod]);
        expect(sent).toEqual([{ type: "custom", event: LocaleUpdateEvent, data: { code: "fr" } }]);

        expect(moltentermLocalesHot().handleHotUpdate({ ...ctx, file: "/repo/frontend/app/app.tsx" })).toBeUndefined();
        expect(sent).toHaveLength(1);
    });
});
