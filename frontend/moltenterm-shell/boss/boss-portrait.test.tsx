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
    name: "Brokk",
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

    it("loads the animated portrait on its own, not with the bubble", () => {
        const source = readFileSync(join(__dirname, "boss-portrait.tsx"), "utf8");
        expect(source).toMatch(/lazy\(\(\) => import\("\.\/brokk-live"\)/);
        expect(source).not.toMatch(/^import (?!type).* from "\.\/brokk-live"/m);
        expect(source).toMatch(/import type \{ BrokkLiveProps \} from "\.\/brokk-live"/);
        for (const file of ["boss-bubble.tsx", "boss-card.tsx", "use-brokk-live.ts"]) {
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

    it("turns off all the package draws but the clips, so that nothing the bubble's screen draws is doubled", () => {
        for (const part of [
            "character-still",
            "character-tint",
            "character-scanlines",
            "character-sweep",
            "character-vignette",
            "character-corner",
            "character-live",
            "character-caption",
        ]) {
            expect(live).toContain(`.${part}`);
        }
        expect(live).toMatch(/:is\([^)]*\.character-caption[^)]*\) \{\s*display: none;/);
    });

    it("lays the clips in the frame and leaves the package's frame out", () => {
        expect(live).toMatch(/\.mt-brokk-portrait \.character-screen \{[^}]*position: absolute;[^}]*inset: 0;/);
        expect(live).toMatch(/\.mt-brokk-portrait \.character-screen \{[^}]*box-shadow: none;/);
    });

    it("puts no filter on a clip, which Chromium draws with a lighter rectangle past the edge of the round", () => {
        expect(live).toMatch(/\.mt-brokk-portrait \.character-video \{\s*filter: none;/);
        // No other rule of the file filters anything above or around a clip.
        expect(live.match(/filter:/g)).toHaveLength(2);
        expect(live).toMatch(/\.mt-boss-portrait:has\(\.mt-brokk-live\) \.mt-boss-portrait-image \{\s*filter: none;/);
    });

    it("keeps the still's own filter when no clip plays, and lets it go smoothly when they start", () => {
        const still = css("boss-portrait.css");
        expect(still).toMatch(
            /\.mt-boss-portrait-image \{[^}]*filter: saturate\(0\.75\) contrast\(1\.1\) brightness\(0\.95\);/
        );
        // The still at rest has no motion of its own (boss-bubble.test.tsx): the fade comes with the clips' stylesheet.
        expect(still).not.toMatch(/animation|transition/);
        expect(live).toMatch(/\.mt-boss-portrait-image \{\s*transition: filter var\(--mt-duration-base\)/);
        expect(live).toMatch(/\.prefers-reduced-motion \.mt-boss-portrait-image,[\s\S]*\{\s*transition: none;/);
    });

    it("stills the still's breathing under the clips, and the clips' fade under reduced motion", () => {
        expect(live).toMatch(
            /\.mt-boss-bubble \.mt-boss-portrait:has\(\.mt-brokk-live\) \.mt-boss-portrait-image \{\s*animation: none;/
        );
        expect(live).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-boss-portrait-image,\s*\.mt-brokk-portrait \.character-video \{\s*transition: none;/
        );
        expect(live).toMatch(
            /\.prefers-reduced-motion \.mt-boss-portrait-image,\s*\.prefers-reduced-motion \.mt-brokk-portrait \.character-video \{\s*transition: none;/
        );
    });

    it("keeps the screen of the bubble as it is: its corners, scanlines, Online mark and caption are not in this file", () => {
        const screen = css("boss-screen.css");
        for (const part of [".mt-boss-corner", ".mt-boss-scan", ".mt-boss-live", ".mt-boss-caption"]) {
            expect(screen).toContain(part);
            expect(live).not.toContain(part);
        }
    });
});
