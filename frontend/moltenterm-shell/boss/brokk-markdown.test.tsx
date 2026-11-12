// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { revealedMarkdown } from "./brokk-exchange-model";
import { BrokkMarkdown } from "./brokk-markdown";

function md(text: string): string {
    return renderToStaticMarkup(<BrokkMarkdown text={text} />);
}

// FR-BOSS-009 AC89 (#2285): his answers read as Markdown, and stay data: nothing in them runs, loads or navigates.
describe("his Markdown, read safely", () => {
    it("shows raw HTML as the text he wrote, never as markup", () => {
        const html = md(
            'Look: <img src="https://example.invalid/x.png" onerror="alert(1)"> and <script>alert(2)</script>'
        );
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain("&lt;img src=");
        expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    });

    it("never loads an image: it shows its text", () => {
        const html = md("Here: ![the plan](https://example.invalid/plan.png)");
        expect(html).not.toContain("<img");
        expect(html).not.toContain("example.invalid");
        expect(html).toContain("[the plan]");
    });

    it("shows a link's text and its address, with nothing to click", () => {
        const html = md("See [the guide](https://example.invalid/guide) or https://example.invalid/raw.");
        expect(html).not.toContain("<a ");
        expect(html).not.toContain("href=");
        expect(html).toContain('the guide<span class="mt-brokk-md-href"> (https://example.invalid/guide)</span>');
        // A bare address says itself once.
        expect(html.match(/https:\/\/example\.invalid\/raw/g)).toHaveLength(1);
        expect(md("[x](javascript:alert(1))")).not.toContain("<a ");
    });

    it("draws headings as strong lines of his answer, and tables, quotes and rules", () => {
        const html = md("# Plan\n\n> a quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---");
        expect(html).not.toMatch(/<h[1-6]/);
        expect(html).toContain('<p class="mt-brokk-md-h">Plan</p>');
        expect(html).toContain("<blockquote>");
        expect(html).toContain("<table>");
        expect(html).toContain("<hr/>");
    });

    it("leaves out what he has no use for, keeping its words: a task list's checkbox", () => {
        const html = md("- [x] done\n- [ ] to do");
        expect(html).not.toContain("<input");
        expect(html).toContain("done");
        expect(html).toContain("to do");
    });
});

// AC87 with AC89: while he speaks, the part said is closed where the cut leaves a mark open.
describe("the part said so far", () => {
    it("closes a strong emphasis or an inline code the cut leaves open, and nothing else", () => {
        expect(revealedMarkdown("A **very bold** idea", "A **very".length)).toBe("A **very**");
        expect(revealedMarkdown("A **very bold** idea", "A **very ".length)).toBe("A **very**");
        expect(revealedMarkdown("Run `molten ci` now", "Run `molten".length)).toBe("Run `molten`");
        expect(revealedMarkdown("A **bold** idea", "A **bold** id".length)).toBe("A **bold** id");
        expect(revealedMarkdown("Code `a**b` here", "Code `a**b` he".length)).toBe("Code `a**b` he");
    });

    it("leaves an open code block as it is: it runs to the end, as it will", () => {
        const text = "Then:\n\n```sh\nmolten ci status\n```\nDone.";
        expect(revealedMarkdown(text, "Then:\n\n```sh\nmolten".length)).toBe("Then:\n\n```sh\nmolten");
        expect(revealedMarkdown(text, text.length)).toBe(text);
    });

    it("says nothing before his first word, and everything once whole", () => {
        expect(revealedMarkdown("Hello.", 0)).toBe("");
        expect(revealedMarkdown("Hello.", 99)).toBe("Hello.");
        expect(revealedMarkdown(null, 3)).toBe("");
    });
});
