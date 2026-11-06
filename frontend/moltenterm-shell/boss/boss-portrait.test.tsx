// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BossPortrait } from "./boss-portrait";
import type { BrokkLiveProps } from "./brokk-live";

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const Live: BrokkLiveProps = {
    situation: { working: 0, waiting: 0, cardOpen: false },
    asked: null,
};

describe("his portrait (FR-BOSS-001, AC1; FR-BOSS-007, AC5)", () => {
    it("is his still alone when nothing asks for it to move", () => {
        const html = renderToStaticMarkup(<BossPortrait />);
        expect(html).toMatch(/<span class="mt-boss-portrait" aria-hidden="true"><img class="mt-boss-portrait-image"/);
        expect(html).not.toContain("<video");
        expect(html).not.toContain("brokk-live");
    });

    it("keeps his still in the frame while the animated portrait loads, which is the fallback if it never does", () => {
        const html = renderToStaticMarkup(<BossPortrait live={Live} />);
        expect(html).toMatch(/<img class="mt-boss-portrait-image" src="[^"]*brokk[^"]*\.jpg"/);
        expect(html).not.toContain("<video");
    });

    it("loads the animated portrait on its own, not with the avatar", () => {
        const source = readFileSync(join(__dirname, "boss-portrait.tsx"), "utf8");
        expect(source).toMatch(/lazy\(\(\) => import\("\.\/brokk-live"\)/);
        expect(source).not.toMatch(/^import (?!type).* from "\.\/brokk-live"/m);
        expect(source).toMatch(/import type \{ BrokkLiveProps \} from "\.\/brokk-live"/);
        for (const file of ["brokk-avatar.tsx", "boss-card.tsx", "use-brokk-live.ts"]) {
            const user = readFileSync(join(__dirname, file), "utf8");
            expect(user, file).not.toMatch(/^import (?!type).* from "\.\/(brokk-live|brokk-portrait)"/m);
            expect(user, file).not.toContain("@diamondforge/character");
        }
    });
});

describe("the animated portrait over his still (FR-BOSS-007, AC1)", () => {
    const live = css("brokk-live.css");

    it("sets the package's tint to the ember of the action colour", () => {
        expect(live).toMatch(/--character-accent: var\(--mt-action-hover\);/);
        expect(live).toMatch(/--character-tint: var\(--mt-action\);/);
    });

    it("asks the package for the picture alone, so that nothing the bubble's screen draws is doubled", () => {
        const source = readFileSync(join(__dirname, "brokk-live.tsx"), "utf8");
        expect(source).toMatch(/<TransmissionPortrait[^>]*\sbare\s/);
        expect(source).not.toMatch(/\b(name|role|live)=\{/);
        expect(source).not.toContain("useT");
        // None of the package's frame is turned off by hand any more: only its own still, under which stands the app's.
        expect(live).not.toContain(".character-screen");
        for (const part of [
            "character-tint",
            "character-scanlines",
            "character-sweep",
            "character-vignette",
            "character-corner",
            "character-live",
            "character-caption",
        ]) {
            expect(live).not.toContain(`.${part}`);
        }
        expect(live).toMatch(/\.mt-brokk-portrait \.character-still \{\s*display: none;/);
    });

    it("lays the clips in the frame, and keeps a pointer and a selection off them", () => {
        expect(live).toMatch(/\.mt-brokk-portrait \{[^}]*position: absolute;[^}]*inset: 0;/);
        expect(live).toMatch(
            /\.mt-brokk-portrait \.character-video \{\s*user-select: none;\s*-webkit-user-select: none;\s*pointer-events: none;/
        );
    });

    it("puts no filter on a clip, which Chromium draws with a lighter rectangle past the edge of the round", () => {
        // A bare picture wears no tone, so no rule of the file filters a clip or anything above it.
        expect(live).not.toMatch(/\.character-video \{[^}]*filter:/);
        expect(live.match(/filter:/g)).toHaveLength(1);
        expect(live).toMatch(/\.mt-boss-portrait:has\(\.mt-brokk-live\) \.mt-boss-portrait-image \{\s*filter: none;/);
    });

    it("keeps the still's own filter when no clip plays, and lets it go smoothly when they start", () => {
        const still = css("boss-portrait.css");
        expect(still).toMatch(
            /\.mt-boss-portrait-image \{[^}]*filter: saturate\(0\.75\) contrast\(1\.1\) brightness\(0\.95\);/
        );
        // The still at rest has no motion of its own (brokk-avatar.test.tsx): the fade comes with the clips' stylesheet.
        expect(still).not.toMatch(/animation|transition/);
        expect(live).toMatch(/\.mt-boss-portrait-image \{\s*transition: filter var\(--mt-duration-base\)/);
        expect(live).toMatch(/\.prefers-reduced-motion \.mt-boss-portrait-image,[\s\S]*\{\s*transition: none;/);
    });

    it("stills the clips' fade under reduced motion", () => {
        expect(live).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-boss-portrait-image,\s*\.mt-brokk-portrait \.character-video \{\s*transition: none;/
        );
        expect(live).toMatch(
            /\.prefers-reduced-motion \.mt-boss-portrait-image,\s*\.prefers-reduced-motion \.mt-brokk-portrait \.character-video \{\s*transition: none;/
        );
    });

    it("draws the picture alone: no corner, scanline, Online mark or caption of a screen is in this file", () => {
        for (const part of [".mt-boss-corner", ".mt-boss-scan", ".mt-boss-live", ".mt-boss-caption"]) {
            expect(live).not.toContain(part);
        }
    });
});
