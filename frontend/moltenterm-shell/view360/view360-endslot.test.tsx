// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { addCarpetPanel } from "./carpet-add";
import { computeCarpetLayout } from "./carpet-model";
import { endSlotRect } from "./carpet-peeks";
import { addAtSlot, CarpetEndSlot } from "./view360-endslot";

vi.mock("./carpet-add", () => ({ addCarpetPanel: vi.fn(() => Promise.resolve("new-block")) }));

const dir = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(`${dir}view360-endslot.css`, "utf8");

const layout = computeCarpetLayout({
    width: 1600,
    height: 900,
    fixedNodeId: "term",
    fixedPx: 600,
    columns: [
        { nodeId: "a", widthPx: 484 },
        { nodeId: "b", widthPx: 484 },
    ],
});
const layoutModel = {} as LayoutModel;

function slot(side: "left" | "right") {
    return renderToStaticMarkup(<CarpetEndSlot layoutModel={layoutModel} layout={layout} side={side} halfGap={4} />);
}

describe("the add-panel slot at an end of the carpet (#1836, FR-SHELL-065 AC15)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    beforeEach(() => {
        vi.mocked(addCarpetPanel).mockClear();
    });

    it('is a button named and described "Add a panel here", with a plus', () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const html = slot("left");
        expect(html).toMatch(/^<button type="button"/);
        expect(html).toContain('aria-label="Add a panel here"');
        expect(html).toContain('title="Add a panel here"');
        expect(html).toContain('data-testid="mt-carpet-end-slot"');
        expect(html).toContain('class="mt-endslot-plus" aria-hidden="true"');
        expect(html).toContain('class="mt-endslot-light" aria-hidden="true"');
    });

    it("speaks French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = slot("right");
        expect(html).toContain('aria-label="Ajouter un panneau ici"');
        expect(html).toContain('title="Ajouter un panneau ici"');
    });

    it("is placed in its gutter at the height of the panels, on the side it serves", () => {
        const left = endSlotRect(layout, "left", 4);
        const right = endSlotRect(layout, "right", 4);
        expect(slot("left")).toContain(
            `transform:translate3d(${left.left}px, ${left.top}px, 0);width:${left.width}px;height:${left.height}px`
        );
        expect(slot("left")).toContain('data-side="left"');
        expect(slot("right")).toContain(`translate3d(${right.left}px, ${right.top}px, 0)`);
        expect(slot("right")).toContain('data-side="right"');
    });

    it("adds a panel at the start from the left slot and at the end from the right one", async () => {
        await addAtSlot(layoutModel, "left");
        await addAtSlot(layoutModel, "right");
        expect(vi.mocked(addCarpetPanel).mock.calls).toEqual([
            [layoutModel, "start"],
            [layoutModel, "end"],
        ]);
    });
});

describe("the slot's style under reduced motion (#1836)", () => {
    it("runs its light once, with the glow token and transform and opacity only", () => {
        expect(css).toMatch(/animation: mt-endslot-run var\(--mt-duration-glow\) var\(--mt-ease\) 1 both/);
        const keyframes = /@keyframes mt-endslot-run \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        const props = [...keyframes.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
        expect(new Set(props)).toEqual(new Set(["opacity", "transform"]));
    });

    it("stills the light under the system preference and MoltenTerm's own setting, leaving only the colours", () => {
        // Each still rule must be as specific as the one that runs the light, and come after it, or it would lose.
        const runAt = css.indexOf(".mt-endslot:hover .mt-endslot-light::before,\n.mt-endslot:focus-visible");
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
        expect(runAt).toBeGreaterThan(-1);
        expect(media?.index).toBeGreaterThan(runAt);
        expect(media?.[1]).toMatch(
            /\.mt-endslot:hover \.mt-endslot-light::before,\s*\.mt-endslot:focus-visible \.mt-endslot-light::before \{\s*animation: none;/
        );
        const own = css.indexOf(".prefers-reduced-motion .mt-endslot:hover .mt-endslot-light::before");
        expect(own).toBeGreaterThan(runAt);
        expect(css.slice(own)).toMatch(
            /^\.prefers-reduced-motion \.mt-endslot:hover \.mt-endslot-light::before,\s*\.prefers-reduced-motion \.mt-endslot:focus-visible \.mt-endslot-light::before \{\s*animation: none;/
        );
    });

    it("is calm at rest: no animation outside hover and keyboard focus", () => {
        const withoutHover = css.replace(/\.mt-endslot:hover[\s\S]*?\}/g, "");
        const rest = withoutHover.replace(/@keyframes[\s\S]*?\n\}/g, "").replace(/@media[\s\S]*?\n\}/g, "");
        const restAnimations = rest.split("\n").filter((l) => /animation:/.test(l) && !/animation: none/.test(l));
        expect(restAnimations).toEqual([]);
    });
});
