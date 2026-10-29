// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The empty workspace (FR-SHELL-110 AC-4, audit #1316 F5): what a workspace is, why this one is empty, how to start,
// with two actions.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { templateViewsText } from "../workspace-views/template-views";
import { EmptyWorkspaceState } from "./empty-workspace";

const noop = () => {};

function render(viewsText: string, error?: string) {
    return renderToStaticMarkup(
        <EmptyWorkspaceState viewsText={viewsText} busy={false} error={error} onAddViews={noop} onNewView={noop} />
    );
}

describe("EmptyWorkspaceState", () => {
    it("offers the default views as the molten action, and a new view beside it", () => {
        const html = render("Scoping and Control room");
        expect(html).toContain('data-testid="empty-workspace"');
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="empty-workspace-add-views"/);
        expect(html).toMatch(/class="molten-btn-secondary [^"]*"[^>]*data-testid="empty-workspace-new-view"/);
        expect(html.match(/class="molten-btn /g)).toHaveLength(1);
    });

    it("offers only a new view when the template has no view", () => {
        const html = render("");
        expect(html).not.toContain("empty-workspace-add-views");
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="empty-workspace-new-view"/);
    });

    it("shows a failed addition in plain words", () => {
        expect(render("Scoping", "The views could not be added")).toContain('role="alert"');
    });

    it("says what a workspace is, why it is empty and how to start, in both languages", () => {
        for (const dict of [en, fr] as any[]) {
            const keys = dict.sidebar.emptyWorkspace;
            expect(keys.title).toBeTruthy();
            expect(keys.hint).toContain("{views}");
            expect(keys.hintNoTemplate).toBeTruthy();
            expect(keys.addViews).toBeTruthy();
            expect(keys.newView).toBeTruthy();
        }
        expect((fr as any).sidebar.emptyWorkspace.title).toContain("espace de travail");
    });
});

describe("templateViewsText", () => {
    const tr = (key: string) => ({ "workspaceViews.names.scoping": "Cadrage", "workspaceViews.names.pilotage": "Pilotage" })[key] ?? key;
    const views = [
        { namekey: "workspaceViews.names.scoping", panels: ["agent"] },
        { namekey: "workspaceViews.names.pilotage", panels: ["project"] },
    ];

    it("lists the views the interface language's way", () => {
        expect(templateViewsText(views, tr, "fr")).toBe("Cadrage et Pilotage");
        expect(templateViewsText([{ name: "Docs", panels: ["browser"] }, ...views], tr, "en")).toBe(
            "Docs, Cadrage, and Pilotage"
        );
    });
});
