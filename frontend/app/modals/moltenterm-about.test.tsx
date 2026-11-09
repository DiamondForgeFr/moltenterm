// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The About panel names the licence (#1870): AGPL-3.0 for MoltenTerm, Apache-2.0 for the parts from Wave Terminal, with a
// link to NOTICE, which says which part is under which licence. It also opens the third-party notices (#2126).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";
import { AboutLicenseLine, AboutNoticesView, noticesOpened } from "./moltenterm-about";

afterEach(async () => {
    I18nModel.getInstance().setLanguageSetting("en");
    await I18nModel.getInstance().whenReady();
});

describe("AboutLicenseLine", () => {
    it("names both licences and links to NOTICE", () => {
        const html = renderToStaticMarkup(<AboutLicenseLine />);
        expect(html).toContain("AGPL-3.0");
        expect(html).toContain("Apache-2.0");
        expect(html).toContain("/blob/main/NOTICE");
        expect(html).toContain('data-testid="about-license"');
    });

    it("does not claim a registered trademark", () => {
        expect(renderToStaticMarkup(<AboutLicenseLine />)).not.toContain("®");
    });
});

describe("AboutNoticesView", () => {
    it("offers the open-source licences as a button, not as a web link", () => {
        const html = renderToStaticMarkup(<AboutNoticesView missing={false} onOpen={() => {}} />);
        expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="about-open-source-licenses"/);
        expect(html).toContain("Open-source licences");
        expect(html).not.toContain("href=");
        expect(html).not.toContain("about-open-source-licenses-missing");
    });

    it("says in place that the build holds no notices file", () => {
        const html = renderToStaticMarkup(<AboutNoticesView missing={true} onOpen={() => {}} />);
        expect(html).toMatch(/role="status"[^>]*data-testid="about-open-source-licenses-missing"/);
        expect(html).toContain("This build does not contain the licence notices.");
    });

    it("speaks French", async () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        await I18nModel.getInstance().whenReady();
        const html = renderToStaticMarkup(<AboutNoticesView missing={true} onOpen={() => {}} />);
        expect(html).toContain("Licences open source");
        expect(html).toContain("Cette version ne contient pas les notices de licences.");
    });

    it("names no machine or system in either language", async () => {
        const words = /\b(Mac|macOS|Finder|Windows|Linux|Explorer)\b/;
        for (const language of ["en", "fr"]) {
            I18nModel.getInstance().setLanguageSetting(language);
            await I18nModel.getInstance().whenReady();
            expect(renderToStaticMarkup(<AboutNoticesView missing={true} onOpen={() => {}} />)).not.toMatch(words);
        }
    });
});

describe("noticesOpened", () => {
    it("is true when main handed the file to the system's viewer", async () => {
        expect(await noticesOpened(async () => true)).toBe(true);
    });

    it("is false when the build holds no file", async () => {
        expect(await noticesOpened(async () => false)).toBe(false);
    });

    it("is false, not an error, when main refuses or fails", async () => {
        const failing = vi.fn().mockRejectedValue(new Error("IPC caller not authorized"));
        expect(await noticesOpened(failing)).toBe(false);
        expect(failing).toHaveBeenCalledTimes(1);
    });

    it("is false for an answer that is not true", async () => {
        expect(await noticesOpened(async () => undefined as unknown as boolean)).toBe(false);
    });
});
