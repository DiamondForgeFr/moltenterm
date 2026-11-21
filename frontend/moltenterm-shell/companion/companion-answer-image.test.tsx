// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../app/element/markdown";
import { pastedImageChip } from "./companion-image-chip";
import { companionMarkdown } from "./companion-model";
import { pastedImageNumber } from "./companion-tips-model";

// The latest answer goes through the markdown renderer (FR-SHELL-018, #2455): an "[Image #N]" in it is the same chip
// as in the hero and the recent topics (the icon and "Image #N"), a list item's included, and a placeholder in code is
// code.
const answer = (markdown: string) =>
    renderToStaticMarkup(<Markdown text={companionMarkdown(markdown)} scrollable={false} />);

const chips = (html: string) =>
    [...html.matchAll(/<button type="button" class="mt-cdash-imgchip"[^>]*>/g)].map((m) => m[0]);
const numbers = (html: string) => chips(html).map((tag) => /data-image="(\d+)"/.exec(tag)?.[1]);

describe("a pasted image in the latest answer (#2455)", () => {
    it("is the chip of the hero and the topics, icon and number, in a paragraph", () => {
        const html = answer("As in [Image #7], the button is too close.");
        expect(numbers(html)).toEqual(["7"]);
        expect(html).toMatch(
            /<button type="button" class="mt-cdash-imgchip"[^>]*><svg[^>]*lucide-image[^>]*>.*<\/svg>Image #7<\/button>/
        );
        expect(html).not.toContain("[Image #7]");
        expect(html).not.toContain("<a ");
        expect(html).toContain("As in ");
        expect(html).toContain(", the button is too close.");
    });

    it("is the same chip inside bulleted and numbered lists, at every depth", () => {
        const html = answer(
            "- the first list item shows [Image #1]\n- the second shows [Image #2] and [Image #3]\n  - a nested one shows [Image #4]\n\n1. the first step shows [Image #5]\n2. the second has none"
        );
        expect(numbers(html)).toEqual(["1", "2", "3", "4", "5"]);
        expect(html.match(/<li>/g)?.length).toBeGreaterThanOrEqual(5);
        for (const item of html.split("<li>").slice(1)) {
            expect(item).not.toContain("[Image #");
        }
    });

    it("stays text in code, inline or fenced, and in a link to somewhere else", () => {
        const html = answer("`[Image #8]` and\n\n```\n[Image #9]\n```\n\nand [the docs](https://docs.example/page)");
        expect(numbers(html)).toEqual([]);
        expect(html).toContain("[Image #8]");
        expect(html).toContain("[Image #9]");
        expect(html).toContain('href="https://docs.example/page"');
    });

    it("tells a placeholder's link from any other", () => {
        expect(pastedImageNumber("#mt-image-12")).toBe(12);
        expect(pastedImageNumber("#heading")).toBe(0);
        expect(pastedImageNumber("https://example.test/#mt-image-3")).toBe(0);
        expect(pastedImageNumber(undefined)).toBe(0);
        expect(pastedImageChip("#heading")).toBeNull();
        expect(pastedImageChip("#mt-image-2")).not.toBeNull();
    });
});
