// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BossPortrait, LiveBoundary } from "./boss-portrait";
import { RetryDelaysMs } from "./boss-portrait-retry";
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
        expect(html).toMatch(
            /<span class="mt-boss-portrait" data-framing="head" aria-hidden="true"><img class="mt-boss-portrait-image"/
        );
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
        for (const file of ["brokk-avatar.tsx", "brokk-group.tsx", "use-brokk-live.ts"]) {
            const user = readFileSync(join(__dirname, file), "utf8");
            expect(user, file).not.toMatch(/^import (?!type).* from "\.\/(brokk-live|brokk-portrait)"/m);
            expect(user, file).not.toContain("@diamondforge/character");
        }
    });
});

// The boundary is driven by hand, as React would: the tests run in a plain Node environment, which mounts nothing.
describe("a portrait that failed to load is tried again (FR-BOSS-009, AC1, #2219, AC-3)", () => {
    function makeBoundary() {
        const boundary = new LiveBoundary({ live: Live });
        const setState = vi.fn((state: { failed: boolean }) => {
            boundary.state = { ...boundary.state, ...state };
        });
        boundary.setState = setState as any;
        return { boundary, setState };
    }

    // What React does when a child throws.
    function fail(boundary: LiveBoundary) {
        boundary.state = LiveBoundary.getDerivedStateFromError();
        boundary.componentDidCatch(new Error("clip chunk failed"));
    }

    // The lazy component the boundary draws now.
    function lazyOf(boundary: LiveBoundary): unknown {
        const drawn = boundary.render() as any;
        return drawn?.props?.children?.type;
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("draws nothing over the still while it waits, then draws the portrait again by itself", () => {
        const { boundary, setState } = makeBoundary();
        expect(lazyOf(boundary)).toBeDefined();
        fail(boundary);
        expect(boundary.render()).toBeNull();
        vi.advanceTimersByTime(RetryDelaysMs[0] - 1);
        expect(setState).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(setState).toHaveBeenCalledWith({ failed: false });
        expect(boundary.render()).not.toBeNull();
    });

    it("makes the lazy import again, since one that failed stays failed for good", () => {
        const { boundary } = makeBoundary();
        const before = lazyOf(boundary);
        fail(boundary);
        vi.advanceTimersByTime(RetryDelaysMs[0]);
        const after = lazyOf(boundary);
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
        // A face that comes back in view mounts a boundary of its own and finds the new one at once.
        expect(lazyOf(makeBoundary().boundary)).toBe(after);
    });

    it("renews the lazy once for the lazy that failed, however many faces drew it", () => {
        const first = makeBoundary().boundary;
        const second = makeBoundary().boundary;
        const old = lazyOf(first);
        expect(lazyOf(second)).toBe(old);
        fail(first);
        const renewed = lazyOf(makeBoundary().boundary);
        expect(renewed).not.toBe(old);
        fail(second);
        expect(lazyOf(makeBoundary().boundary)).toBe(renewed);
    });

    it("waits longer when the retry fails again, and stops when the face leaves the page", () => {
        const { boundary, setState } = makeBoundary();
        fail(boundary);
        vi.advanceTimersByTime(RetryDelaysMs[0]);
        expect(setState).toHaveBeenCalledTimes(1);
        fail(boundary);
        vi.advanceTimersByTime(RetryDelaysMs[1] - 1);
        expect(setState).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(setState).toHaveBeenCalledTimes(2);
        fail(boundary);
        boundary.componentWillUnmount();
        vi.advanceTimersByTime(10 * RetryDelaysMs[2]);
        expect(setState).toHaveBeenCalledTimes(2);
    });

    it("is not drawn again for what the surface around it draws: the live props are what it depends on", () => {
        const source = readFileSync(join(__dirname, "boss-portrait.tsx"), "utf8");
        expect(source).toMatch(/export const BossPortrait = memo\(function BossPortrait\(/);
        expect(source).toContain("{live != null ? <LiveBoundary live={live} /> : null}");
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
