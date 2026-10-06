// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { readFileSync } from "fs";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VTab } from "../app/tab/vtab";
import { contrastRatio, mixColor, MoltentermDefaultAccent, parseColor } from "./accent";
import {
    clampHoldMs,
    HoldToCloseButton,
    HoldToCloseDefaultMs,
    HoldToCloseFlashMs,
    HoldToCloseGlyph,
    HoldToCloseLabel,
    HoldToCloseRing,
    HoldToCloseTint,
    HoldToCloseTintMax,
    makeHoldToCloseController,
    resolveHoldToCloseSettings,
} from "./hold-to-close";

const WorkspaceColours = [
    MoltentermDefaultAccent,
    "#00FFDB",
    "#429DFF",
    "#BF55EC",
    "#FF453A",
    "#58C142",
    "#FFE900",
    "#FF9500",
    "#1E3A8A",
];

function makeHarness(durationMs = 600) {
    const events: string[] = [];
    const controller = makeHoldToCloseController(durationMs, {
        onHoldChange: (holding) => events.push(holding ? "hold" : "empty"),
        onComplete: () => events.push("close"),
        onHint: () => events.push("hint"),
    });
    return { controller, events };
}

describe("hold-to-close controller", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("closes once the hold reaches the duration", () => {
        const { controller, events } = makeHarness();
        controller.press();
        vi.advanceTimersByTime(599);
        expect(events).toEqual(["hold"]);
        vi.advanceTimersByTime(1);
        expect(events).toEqual(["hold", "empty", "close"]);
        expect(controller.holding).toBe(false);
    });

    it("cancels on an early release and shows the hint instead of closing", () => {
        const { controller, events } = makeHarness();
        controller.press();
        vi.advanceTimersByTime(300);
        controller.release();
        vi.advanceTimersByTime(2000);
        expect(events).toEqual(["hold", "empty", "hint"]);
    });

    it("cancels without a hint when the pointer leaves or the button loses focus", () => {
        const { controller, events } = makeHarness();
        controller.press();
        controller.cancel();
        controller.press();
        controller.cancel();
        vi.advanceTimersByTime(2000);
        expect(events).toEqual(["hold", "empty", "hold", "empty"]);
    });

    it("ignores a repeated press while held, like a key's auto-repeat", () => {
        const { controller, events } = makeHarness(400);
        controller.press();
        vi.advanceTimersByTime(300);
        controller.press();
        vi.advanceTimersByTime(100);
        expect(events).toEqual(["hold", "empty", "close"]);
    });

    it("does nothing on a release or cancel without a press", () => {
        const { controller, events } = makeHarness();
        controller.release();
        controller.cancel();
        expect(events).toEqual([]);
    });

    it("never closes after dispose", () => {
        const { controller, events } = makeHarness();
        controller.press();
        controller.dispose();
        vi.advanceTimersByTime(2000);
        expect(events).toEqual(["hold"]);
    });

    it("uses the clamped duration", () => {
        const { controller, events } = makeHarness(50);
        expect(controller.durationMs).toBe(200);
        controller.press();
        vi.advanceTimersByTime(200);
        expect(events).toContain("close");
    });
});

describe("hold-to-close settings", () => {
    it("clamps the duration to 200-2000 ms and defaults to 600", () => {
        expect(clampHoldMs(50)).toBe(200);
        expect(clampHoldMs(1200)).toBe(1200);
        expect(clampHoldMs(9000)).toBe(2000);
        expect(clampHoldMs(null)).toBe(HoldToCloseDefaultMs);
        expect(clampHoldMs(Number.NaN)).toBe(HoldToCloseDefaultMs);
    });

    it("is on unless explicitly turned off", () => {
        expect(resolveHoldToCloseSettings(undefined, undefined, undefined)).toEqual({
            enabled: true,
            durationMs: 600,
            reducedMotion: false,
        });
        expect(resolveHoldToCloseSettings(false, 1200, true)).toEqual({
            enabled: false,
            durationMs: 1200,
            reducedMotion: true,
        });
    });
});

function renderWithSettings(node: React.ReactNode, settings: Record<string, unknown>, reducedMotion = false): string {
    const env = {
        getSettingsKeyAtom: (key: string) => atom(settings[key]),
        atoms: { prefersReducedMotionAtom: atom(reducedMotion) },
    };
    return renderToStaticMarkup(<WaveEnvContext.Provider value={env as any}>{node}</WaveEnvContext.Provider>);
}

describe("hold-to-close rendering", () => {
    it("names the button for screen readers and draws the ring", () => {
        const markup = renderWithSettings(<HoldToCloseButton onClose={() => null} />, {});
        expect(markup).toContain(`aria-label="${HoldToCloseLabel}"`);
        expect(markup).toContain('title="Hold to close"');
        expect(markup).toContain('data-testid="hold-to-close-ring"');
    });

    it("eases the fill, or steps it under reduced motion", () => {
        const eased = renderToStaticMarkup(<HoldToCloseRing holding={true} durationMs={600} reducedMotion={false} />);
        expect(eased).toContain("stroke-dashoffset 600ms ease-out");
        const stepped = renderToStaticMarkup(<HoldToCloseRing holding={true} durationMs={600} reducedMotion={true} />);
        expect(stepped).toContain("stroke-dashoffset 600ms steps(4, end)");
        expect(stepped).not.toContain("ease-out");
        const idle = renderToStaticMarkup(<HoldToCloseRing holding={false} durationMs={600} reducedMotion={false} />);
        expect(idle).toContain("stroke-dashoffset 160ms ease-out");
        const idleReduced = renderToStaticMarkup(
            <HoldToCloseRing holding={false} durationMs={600} reducedMotion={true} />
        );
        expect(idleReduced).toContain("transition:none");
    });

    it("grows the tint with the hold up to 25 %, steps it under reduced motion and eases it back", () => {
        const tint = (holding: boolean, reducedMotion: boolean) =>
            renderToStaticMarkup(<HoldToCloseTint holding={holding} durationMs={600} reducedMotion={reducedMotion} />);
        expect(tint(true, false)).toContain("opacity:0.25;transition:opacity 600ms linear");
        expect(tint(true, true)).toContain("opacity 600ms steps(4, end)");
        expect(tint(false, false)).toContain("opacity:0;transition:opacity 160ms ease-out");
        expect(tint(false, true)).toContain("transition:none");
    });

    it("draws the glyph and the ring on one 16 px circle, with at least 2 px between them", () => {
        const glyph = renderToStaticMarkup(<HoldToCloseGlyph />);
        expect(glyph).toContain('viewBox="0 0 16 16"');
        const ring = renderToStaticMarkup(<HoldToCloseRing holding={false} durationMs={600} reducedMotion={false} />);
        expect(ring).toContain('viewBox="0 0 16 16"');
        expect(ring).toContain('r="7.25"');
        const path = / d="([^"]*)"/.exec(glyph)[1];
        const points = [...path.matchAll(/\d+/g)].map((m) => Number(m[0]));
        expect(points).toHaveLength(8);
        const half = 1.5 / 2;
        for (let i = 0; i < points.length; i += 2) {
            const centreLineEnd = Math.hypot(points[i] - 8, points[i + 1] - 8);
            // A butt cap's corners sit half a stroke away from the centre line's end, at right angles to it.
            const farthest = Math.hypot(centreLineEnd, half);
            expect(7.25 - half - farthest).toBeGreaterThanOrEqual(2);
        }
    });

    it("flashes the surface on completion and closes after the flash, at once under reduced motion", () => {
        const css = readFileSync(new URL("./hold-to-close.css", import.meta.url), "utf8");
        expect(css).toContain("[data-completing] .molten-hold-close-tint");
        expect(css).toContain("[data-reduced-motion][data-completing] .molten-hold-close-tint");
        expect(css).toContain("scale(0.92)");
        expect(css).toContain(".molten-hold-close:focus-visible .molten-hold-close-disc");
        expect(HoldToCloseFlashMs).toBeLessThanOrEqual(150);
    });

    it("keeps the glyph readable on the full tint, for every workspace colour (NFR-SHELL-003)", () => {
        const css = readFileSync(new URL("./hold-to-close.css", import.meta.url), "utf8");
        const mix = /--molten-hold-glyph: color-mix\(in srgb, var\(--mt-accent\) (\d+)%, white\)/.exec(css);
        expect(mix).not.toBeNull();
        const white = parseColor("#FFFFFF");
        for (const accent of WorkspaceColours) {
            const a = parseColor(accent);
            const glyph = mixColor(a, white, Number(mix[1]));
            for (const panel of ["#0B0B0B", "#1A1A1A", "#262626"]) {
                const tint = mixColor(a, parseColor(panel), HoldToCloseTintMax * 100);
                expect(contrastRatio(glyph, tint), `${accent} on ${panel}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    it("falls back to Wave's single-click button when the setting is off", () => {
        const markup = renderWithSettings(<HoldToCloseButton onClose={() => null} plainLabel="Close tab" />, {
            "tab:holdtoclose": false,
        });
        expect(markup).toContain('aria-label="Close tab"');
        expect(markup).not.toContain("hold-to-close-ring");
    });

    it("mounts in the vertical tab bar", () => {
        const markup = renderWithSettings(
            <VTab
                tab={{ id: "tab-1", name: "Build" }}
                active={false}
                isDragging={false}
                isReordering={false}
                onSelect={() => null}
                onClose={() => null}
                onDragStart={() => null}
                onDragOver={() => null}
                onDrop={() => null}
                onDragEnd={() => null}
            />,
            {}
        );
        expect(markup).toContain(`aria-label="${HoldToCloseLabel}"`);
        expect(markup).toContain("molten-hold-close");
    });
});
