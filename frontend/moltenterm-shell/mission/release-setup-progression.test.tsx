// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup's progression (#1163): Understand, Adjust, Validate as icon tiles, in plain words, with the counts of the
// proposals waiting and the changes accepted on the connectors.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { SetupProgression, setupProgress } from "./release-setup-progression";

const at = { open: 0, accepted: 0, prOpened: false, templateSaved: false };

describe("the setup's progression", () => {
    it("puts step 1 and 2a in Understand, 2b in Adjust, step 3 and the template in Validate", () => {
        expect(setupProgress({ ...at, step: "detect", path: "analyse" }).current).toBe(0);
        expect(setupProgress({ ...at, step: "understand", path: "analyse" }).current).toBe(0);
        expect(setupProgress({ ...at, step: "understand", path: "describe" }).current).toBe(1);
        expect(setupProgress({ ...at, step: "prepare", path: "analyse" }).current).toBe(2);
        expect(setupProgress({ ...at, step: "template", path: "describe" }).current).toBe(2);
    });

    it("draws done, current and next tiles, the parts, and the counts on the connectors", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const p = setupProgress({ ...at, step: "prepare", path: "analyse", open: 2, accepted: 1 });
        const html = renderToStaticMarkup(<SetupProgression current={p.current} markers={p.markers} />);
        expect(html).toMatch(/data-state="done"[^>]*data-testid="progress-tile-understand"/);
        expect(html).toMatch(/data-state="done"[^>]*data-testid="progress-tile-adjust"/);
        expect(html).toMatch(/data-state="current"[^>]*data-testid="progress-tile-validate"/);
        expect(html).toMatch(/data-state="current"[^>]*data-testid="progress-part-proposals"/);
        expect(html).toMatch(/data-state="current"[^>]*data-testid="progress-part-request"/);
        expect(html.match(/data-testid="progress-count"/g)).toHaveLength(2);
        for (const text of ["Comprendre", "Ajuster", "Valider", "Ce que fait votre projet aujourd’hui"]) {
            expect(html).toContain(text);
        }
        I18nModel.getInstance().setLanguageSetting("en");
        const en = renderToStaticMarkup(<SetupProgression current={0} markers={p.markers} />);
        expect(en).toContain("Understand");
        expect(en).toContain("The validation request to review");
        I18nModel.getInstance().setLanguageSetting("fr");
    });
});
