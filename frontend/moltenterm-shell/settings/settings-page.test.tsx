// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { flowColumnsClass, PageCard, pageColumns, PageFlow } from "./settings-page";

describe("page layout on a wide panel (#674)", () => {
    it("gives a page one column per block, three at most", () => {
        expect([0, 1, 2, 3, 7].map(pageColumns)).toEqual([1, 1, 2, 3, 3]);
    });

    it("reads the panel's width, not the window's, and keeps each item whole", () => {
        expect(flowColumnsClass(1)).not.toContain("columns-");
        expect(flowColumnsClass(2)).toContain("@min-[1100px]/page:columns-2");
        expect(flowColumnsClass(2)).not.toContain("columns-3");
        expect(flowColumnsClass(3)).toContain("@min-[1680px]/page:columns-3");
        expect(flowColumnsClass(3)).toContain("[&>*]:break-inside-avoid");
    });

    it("puts each block in its own cell, in order, skipping the absent ones", () => {
        const html = renderToStaticMarkup(
            <PageFlow columns={2}>
                <section id="a" />
                {null}
                {false}
                <section id="b" />
            </PageFlow>
        );
        const cells = html.match(/<div class="pt-\(--df-block-gap\)[^"]*"><section id="(\w)"><\/section><\/div>/g);
        expect(cells?.map((c) => c.match(/id="(\w)"/)[1])).toEqual(["a", "b"]);
    });
});

describe("a settings block states its scope (FR-SHELL-101)", () => {
    it("tags the block after its rows, so the rows keep their place", () => {
        const html = renderToStaticMarkup(
            <PageCard title="Window" scope="app">
                <div id="row" />
            </PageCard>
        );
        expect(html).toContain('data-scope="app"');
        expect(html).toContain("For the whole app");
        expect(html.indexOf('id="row"')).toBeLessThan(html.indexOf("data-scope"));
    });

    it("says nothing for a block without a scope", () => {
        const html = renderToStaticMarkup(
            <PageCard title="Tips">
                <div />
            </PageCard>
        );
        expect(html).not.toContain("data-scope");
    });
});
