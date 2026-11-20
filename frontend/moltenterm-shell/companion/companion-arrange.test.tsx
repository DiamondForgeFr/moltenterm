// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { CompanionArrange } from "./companion-arrange";
import { moveSection, setSectionColumn, setSectionHidden } from "./companion-arrange-model";
import {
    CompanionLayout,
    CompanionSectionIds,
    DefaultCompanionLayout,
    SectionPlacement,
    TwoColumnMinWidth,
} from "./companion-layout";
import { CompanionView } from "./companion-model";
import { SessionBar } from "./companion-session-ui";

vi.mock("@/app/store/global", () => ({ openLink: vi.fn() }));

const noop = () => {};

function markup(layout: CompanionLayout): string {
    return renderToStaticMarkup(<CompanionArrange layout={layout} onSave={noop} onDone={noop} />);
}

// The markup of one row, from its section's mark to the next row's opening tag.
function row(html: string, id: string): string {
    const start = html.indexOf(`data-section="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const next = html.indexOf("<li", start);
    return html.slice(start, next < 0 ? undefined : next);
}

function order(html: string): string[] {
    return [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
}

function inFrench<T>(fn: () => T): T {
    const i18n = I18nModel.getInstance();
    try {
        i18n.setLanguageSetting("fr");
        return fn();
    } finally {
        i18n.setLanguageSetting("");
    }
}

describe("the arranging mode (#2395)", () => {
    it("lists every section once, in the layout's order, each with a handle, a switch and a column choice", () => {
        const html = markup(DefaultCompanionLayout);
        expect(order(html)).toEqual(DefaultCompanionLayout.map((p) => p.id));
        expect(html.match(/data-testid="companion-arrange-handle"/g)).toHaveLength(CompanionSectionIds.length);
        expect(html.match(/data-testid="companion-arrange-switch"/g)).toHaveLength(CompanionSectionIds.length);
        expect(html.match(/role="radiogroup"/g)).toHaveLength(CompanionSectionIds.length);
        const tasks = row(html, "tasks");
        expect(tasks).toContain(">Tasks<");
        expect(tasks).toContain('aria-label="Move Tasks"');
        expect(tasks).toContain('aria-label="Show Tasks"');
        expect(tasks).toContain('aria-label="Tasks: column"');
        expect(tasks).toContain(">Full width<");
        expect(tasks).toContain(">Left<");
        expect(tasks).toContain(">Right<");
    });

    it("names each section by the title it carries in the companion", () => {
        const html = markup(DefaultCompanionLayout);
        for (const name of [
            "Plan usage",
            "Tasks",
            "Agents at work",
            "Permission request",
            "Recent topics",
            "Answer",
            "Workspace task",
            "Files changed",
        ]) {
            expect(html).toContain(`>${name}<`);
        }
    });

    it("shows the arrangement as it was left: order, hidden sections, columns", () => {
        const layout = setSectionColumn(
            setSectionHidden(moveSection(DefaultCompanionLayout, 7, 1), "answer", true),
            "permission",
            "left"
        );
        const html = markup(layout);
        expect(order(html)).toEqual(layout.map((p) => p.id));
        expect(order(html)[1]).toBe("files");
        const answer = row(html, "answer");
        expect(answer).toContain('data-hidden=""');
        expect(answer).toContain('role="switch" aria-checked="false"');
        expect(answer).toContain(">Hidden<");
        expect(row(html, "tasks")).not.toContain("data-hidden");
        expect(row(html, "tasks")).toContain('role="switch" aria-checked="true"');
        expect(row(html, "tasks")).toContain(">Visible<");
        expect(row(html, "permission")).toContain('data-column="left"');
        expect(row(html, "tasks")).toMatch(/aria-checked="true"[^>]*>Left</);
        expect(row(html, "agents")).toMatch(/aria-checked="true"[^>]*>Right</);
        expect(row(html, "files")).toMatch(/aria-checked="true"[^>]*>Full width</);
    });

    it("explains itself: the way to move a section, when the columns apply, that Done saves", () => {
        const html = markup(DefaultCompanionLayout);
        expect(html).toContain("Drag a section by its handle, or focus the handle and press the up or down arrow.");
        expect(html).toContain(`from ${TwoColumnMinWidth} px wide`);
        expect(html).toContain("Done saves the arrangement for every companion.");
        expect(html).toContain("The up and down arrows move it, Home and End take it to the ends.");
        expect(html).toContain('data-testid="companion-arrange-done"');
    });

    // Announced: a named region that takes the focus on its heading, handles with a name and a description, a live
    // region for each move, and switches and radio groups with the section's name.
    it("is announced to screen readers", () => {
        const html = markup(DefaultCompanionLayout);
        expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
        const labelledby = /<section[^>]*aria-labelledby="([^"]+)"/.exec(html)[1];
        expect(html).toContain(`id="${labelledby}"`);
        expect(html).toMatch(/<h3[^>]*tabindex="-1"[^>]*>Arrange the companion</);
        expect(html).toContain('aria-label="Sections of the companion"');
        expect(html).toMatch(/aria-describedby="[^"]+"/);
        expect(html).toMatch(/role="status" aria-live="polite" aria-atomic="true"/);
        expect(html).toContain('class="sr-only"');
        expect(html).toContain("aria-hidden");
    });

    it("offers the way back to the defaults only when there is something to go back from", () => {
        expect(markup(DefaultCompanionLayout)).toMatch(
            /aria-disabled="true"[^>]*data-testid="companion-arrange-reset"/
        );
        const arranged = markup(moveSection(DefaultCompanionLayout, 7, 0));
        expect(arranged).toMatch(/aria-disabled="false"[^>]*data-testid="companion-arrange-reset"/);
        expect(arranged).toContain("Reset to the default layout");
    });

    it("reads in French", () => {
        const html = inFrench(() => markup(DefaultCompanionLayout));
        expect(html).toContain("Agencer le compagnon");
        expect(html).toContain("Revenir à l&#x27;agencement par défaut");
        expect(html).toContain("Pleine largeur");
        expect(html).toContain(">Gauche<");
        expect(html).toContain(">Droite<");
        expect(html).toContain("Déplacer Tâches");
        expect(html).toContain("Afficher Tâches");
        expect(html).toContain(">Terminé<");
        expect(html).not.toContain("Arrange the companion");
    });

    it("draws no switch of its own colour: the state is words and a mark, never colour alone", () => {
        const html = markup(DefaultCompanionLayout);
        expect(html.match(/>Visible</g)).toHaveLength(CompanionSectionIds.length);
        const hidden = markup(DefaultCompanionLayout.map((p): SectionPlacement => ({ ...p, hidden: true })));
        expect(hidden.match(/>Hidden</g)).toHaveLength(CompanionSectionIds.length);
    });
});

describe("the Arrange button of the session bar (#2395)", () => {
    const view: CompanionView = {
        blockid: "b",
        version: 1,
        status: "live",
        agent: "claude",
        agentname: "Claude Code",
        session: { path: "/s/a.jsonl", linkedby: "hook", title: "fix the login tests" },
    };

    it("is discreet: absent until the panel offers it, a pressed state while the mode is on", () => {
        expect(renderToStaticMarkup(<SessionBar view={view} onHistory={noop} />)).not.toContain(
            "companion-arrange-open"
        );
        const off = renderToStaticMarkup(
            <SessionBar view={view} onHistory={noop} onArrange={noop} arranging={false} />
        );
        expect(off).toContain('aria-label="Arrange the companion"');
        expect(off).toContain('aria-pressed="false"');
        expect(off).toContain("fa-table-columns");
        const on = renderToStaticMarkup(<SessionBar view={view} onHistory={noop} onArrange={noop} arranging />);
        expect(on).toContain('aria-pressed="true"');
    });

    it("reads in French", () => {
        const html = inFrench(() =>
            renderToStaticMarkup(<SessionBar view={view} onHistory={noop} onArrange={noop} arranging={false} />)
        );
        expect(html).toContain('aria-label="Agencer le compagnon"');
    });
});
