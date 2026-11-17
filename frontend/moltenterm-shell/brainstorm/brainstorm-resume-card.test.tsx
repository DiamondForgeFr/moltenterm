// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResumeCard } from "./brainstorm-resume-card";

const Css = readFileSync(join(__dirname, "../boss/brokk-group.css"), "utf8");
const Ids = { card: "card", resume: "go", dismiss: "later" };
const Long = "A pocket ledger for allotment gardeners who share tools, seeds and the watering rota";

function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(Css)?.[1] ?? "";
}

function card(extra: { detail?: string; busy?: boolean } = {}): string {
    return renderToStaticMarkup(
        <ResumeCard
            eyebrow="Last brainstorm"
            title={Long}
            label="Resume the last brainstorm"
            testIds={Ids}
            onResume={() => {}}
            onDismiss={() => {}}
            {...extra}
        />
    );
}

// FR-BOSS-009 AC92, DS-BOSS-013 (#2303): one card for the way back and his offer, folded and open.
describe("the resume card", () => {
    it("names what it offers, then the title, the molten Resume and a quiet × for Not now", () => {
        const html = card();
        expect(html).toMatch(
            /^<div role="group" aria-label="Resume the last brainstorm" class="mt-brokk-resume" data-testid="card">/
        );
        expect(html).toMatch(
            /class="mt-brokk-resume-eyebrow"><i class="[^"]*fa-clock-rotate-left[^"]*" aria-hidden="true"><\/i><span class="mt-brokk-resume-eyebrow-text">Last brainstorm</
        );
        expect(html).toMatch(
            /<button type="button" class="mt-brokk-resume-dismiss cursor-pointer" aria-label="Not now" title="Not now" data-testid="later"><i class="[^"]*fa-xmark[^"]*" aria-hidden="true"><\/i><\/button>/
        );
        expect(html).toMatch(
            /<button type="button" class="molten-btn mt-brokk-resume-go [^"]*" data-testid="go">Resume<i class="molten-btn-wave" aria-hidden="true"><\/i><\/button>/
        );
        expect(html).not.toContain("mt-brokk-resume-detail");
    });

    it("keeps the whole title in its tooltip and shows it on one line", () => {
        expect(card()).toContain(
            `<span class="mt-brokk-resume-title" title="${Long}" data-testid="brainstorm-resume-title">${Long}</span>`
        );
        const title = rule(".mt-brokk-resume-title");
        expect(title).toContain("white-space: nowrap;");
        expect(title).toContain("text-overflow: ellipsis;");
        expect(title).toContain("overflow: hidden;");
        expect(title).toContain("min-width: 0;");
    });

    // On the gold, the offer had no surface of its own over the terminal and its text was centred.
    it("is an opaque plate of his group, with the brass rule on his side and its text to the left", () => {
        const plate = rule(".mt-brokk-resume");
        expect(plate).toContain("background: var(--mt-surface-1);");
        expect(plate).toContain("border: 1px solid var(--mt-line-2);");
        expect(plate).toContain("border-left: 2px solid color-mix(in srgb, var(--mt-action) 55%, transparent);");
        expect(plate).toContain("box-shadow: var(--mt-shadow-e2);");
        expect(plate).toContain("text-align: left;");
    });

    it("shows a line under the title when it has one, and holds both buttons while it acts", () => {
        const html = card({ detail: "Last change Nov 12, 2026", busy: true });
        expect(html).toContain('<span class="mt-brokk-resume-detail">Last change Nov 12, 2026</span>');
        expect(html.match(/<button type="button" disabled=""/g)).toHaveLength(2);
        expect(Css).not.toContain("not-allowed");
    });
});
