// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The frame draws through a portal into the window's body; here its title, subtitle, content and buttons are enough.
vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ title, subtitle, children, buttons }: any) => (
        <div data-title={title} data-subtitle={subtitle}>
            {children}
            {buttons}
        </div>
    ),
}));

import { I18nModel } from "../i18n/i18n";
import { shortcutLabel } from "../menu/menu-model";
import { ClearDataDialog } from "./clear-data-dialog";
import { inspectorMenuItems } from "./inspector-menu";
import { siteOriginOf } from "./site-data";

function menu(open: boolean, clearable: boolean, mac: boolean) {
    const calls: string[] = [];
    const items = inspectorMenuItems(
        {
            open,
            clearable,
            inspect: () => calls.push("inspect"),
            close: () => calls.push("close"),
            clearSite: () => calls.push("clear-site"),
            clearCache: () => calls.push("clear-cache"),
        },
        mac
    );
    return { items, calls };
}

describe("a page's right-click: Inspect and the site data (FR-BRW-022 AC1, AC3, TC-BRW-052)", () => {
    it("offers Inspect with the platform's keys, then the two clearings", () => {
        const { items, calls } = menu(false, true, true);
        expect(items.map((i) => i.label)).toEqual(["Inspect", "Clear this site's data…", "Clear the browser cache…"]);
        expect(shortcutLabel(items[0].accelerator, true)).toBe("⌥⌘I");
        expect(shortcutLabel(menu(false, true, false).items[0].accelerator, false)).toBe("Ctrl+Shift+I");
        for (const item of items) {
            item.click();
        }
        expect(calls).toEqual(["inspect", "clear-site", "clear-cache"]);
    });

    it("reads Close inspector, with the keys, while the tools are docked, and keeps Inspect for another element", () => {
        const { items, calls } = menu(true, false, true);
        expect(items.map((i) => i.label)).toEqual(["Inspect", "Close inspector", "Clear the browser cache…"]);
        expect(items[0].accelerator).toBeUndefined();
        expect(shortcutLabel(items[1].accelerator, true)).toBe("⌥⌘I");
        items[1].click();
        expect(calls).toEqual(["close"]);
    });

    it("speaks the interface's language", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(menu(true, true, false).items.map((i) => i.label)).toEqual([
                "Inspecter",
                "Fermer l'inspecteur",
                "Effacer les données de ce site…",
                "Vider le cache du navigateur…",
            ]);
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});

describe("the confirmations of the clearings (FR-BRW-022 AC7, AC8, TC-BRW-054, TC-BRW-055)", () => {
    const html = (request: Parameters<typeof ClearDataDialog>[0]["request"]) =>
        renderToStaticMarkup(<ClearDataDialog request={request} onCancel={() => {}} onConfirm={() => {}} />);

    it("names the origin, the host whose cookies go, what else goes and what stays", () => {
        const site = siteOriginOf("http://localhost:5173/app");
        const out = html({ kind: "site", tabId: "t1", ...site });
        expect(out).toContain('data-title="Clear this site&#x27;s data?"');
        expect(out).toContain('data-subtitle="http://localhost:5173"');
        expect(out).toContain("MoltenTerm&#x27;s browser removes what http://localhost:5173 keeps on this computer:");
        expect(out).toContain("the cookies of localhost, which may sign you out of this site");
        expect(out).toContain("local storage, IndexedDB databases, service workers");
        expect(out).toContain("Other sites keep their data and sign-ins");
        expect(out).toContain("Clear site data");
    });

    it("says the cache goes and the cookies, sign-ins and storage stay", () => {
        const out = html({ kind: "cache", tabId: "t1" });
        expect(out).toContain('data-title="Clear the browser cache?"');
        expect(out).toContain(
            "The files every site opened in MoltenTerm&#x27;s browser keeps in the cache are removed"
        );
        expect(out).toContain("Cookies, sign-ins and the sites&#x27; storage are kept.");
        expect(out).toContain("Clear the cache");
    });
});
