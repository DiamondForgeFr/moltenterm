// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The images of the review (FR-BRW-017 AC26, #2422): the marks drawn on a capture, the picture written small enough for one
// report, the overview set together from the page's screens. A recording context and fake canvases: no DOM.

import { describe, expect, it } from "vitest";
import {
    type CanvasLike,
    composeCrop,
    composeOverview,
    cropTier,
    fitScale,
    OverviewTier,
    type Paint2D,
    type PaintMark,
    paintMarks,
} from "./annotate-paint";

function recorder(): { ctx: Paint2D; calls: string[]; texts: string[] } {
    const calls: string[] = [];
    const texts: string[] = [];
    const ctx: Paint2D = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        font: "",
        textAlign: "",
        textBaseline: "",
        globalAlpha: 1,
        fillRect: (x, y, w, h) => calls.push(`fillRect ${x},${y},${w},${h}@${ctx.globalAlpha}`),
        strokeRect: (x, y, w, h) => calls.push(`strokeRect ${x},${y},${w},${h}`),
        beginPath: () => calls.push("beginPath"),
        moveTo: (x, y) => calls.push(`moveTo ${x},${y}`),
        lineTo: (x, y) => calls.push(`lineTo ${x},${y}`),
        arc: (x, y, r) => calls.push(`arc ${x},${y},${r}`),
        fill: () => calls.push("fill"),
        stroke: () => calls.push("stroke"),
        fillText: (text, x, y) => {
            texts.push(text);
            calls.push(`fillText ${text} ${x},${y}`);
        },
    };
    return { ctx, calls, texts };
}

describe("drawing the marks", () => {
    const size = { w: 1000, h: 800 };
    const zone: PaintMark = { n: 2, kind: "zone", box: { x: 100, y: 200, w: 300, h: 150 }, path: [] };

    it("frames a zone and numbers it on its corner", () => {
        const { ctx, calls, texts } = recorder();
        paintMarks(ctx, [zone], size, "orange");
        expect(calls).toContain("strokeRect 100,200,300,150");
        expect(calls.find((c) => c.startsWith("fillRect"))).toBe("fillRect 100,200,300,150@0.14");
        expect(calls.find((c) => c.startsWith("arc"))).toMatch(/^arc 100,200,/);
        expect(texts).toEqual(["2"]);
    });

    it("draws an outline as a line through its points, numbered where it starts", () => {
        const { ctx, calls, texts } = recorder();
        const path = [
            { x: 60, y: 90 },
            { x: 120, y: 140 },
            { x: 180, y: 90 },
        ];
        paintMarks(ctx, [{ n: 3, kind: "freehand", box: { x: 60, y: 90, w: 120, h: 50 }, path }], size, "orange");
        expect(calls.filter((c) => c.startsWith("moveTo") || c.startsWith("lineTo"))).toEqual([
            "moveTo 60,90",
            "lineTo 120,140",
            "lineTo 180,90",
        ]);
        expect(calls.some((c) => c.startsWith("strokeRect"))).toBe(false);
        expect(calls.find((c) => c.startsWith("arc"))).toMatch(/^arc 60,90,/);
        expect(texts).toEqual(["3"]);
    });

    it("keeps a badge inside the picture, whatever corner its mark is on", () => {
        const { ctx, calls } = recorder();
        paintMarks(ctx, [{ ...zone, box: { x: -40, y: -30, w: 80, h: 60 } }], size, "orange");
        const [, x, y, r] = /^arc (-?[\d.]+),(-?[\d.]+),([\d.]+)/.exec(calls.find((c) => c.startsWith("arc")));
        expect(Number(x) - Number(r)).toBeGreaterThanOrEqual(0);
        expect(Number(y) - Number(r)).toBeGreaterThanOrEqual(0);
    });

    it("scales the badge and the lines with the picture so they read at any size", () => {
        const small = recorder();
        const large = recorder();
        paintMarks(small.ctx, [zone], { w: 500, h: 400 }, "orange");
        paintMarks(large.ctx, [zone], { w: 3000, h: 2400 }, "orange");
        const radius = (calls: string[]) =>
            Number(/^arc [\d.]+,[\d.]+,([\d.]+)/.exec(calls.find((c) => c.startsWith("arc")))[1]);
        expect(radius(large.calls)).toBeGreaterThan(radius(small.calls));
    });
});

// A canvas that remembers how it was drawn on and writes whatever its test says.
function canvases(write: (type: string, quality: number, w: number, h: number) => string) {
    const made: { w: number; h: number; draws: [number, number, number, number][]; labels: string[] }[] = [];
    const make = (width: number, height: number): CanvasLike => {
        const entry = { w: width, h: height, draws: [] as [number, number, number, number][], labels: [] as string[] };
        made.push(entry);
        const { ctx } = recorder();
        const withImage = Object.assign(ctx, {
            drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => entry.draws.push([x, y, w, h]),
            fillText: (text: string) => entry.labels.push(text),
        });
        return {
            width,
            height,
            getContext: () => withImage,
            toDataURL: (type = "image/png", quality = 1) => write(type, quality, width, height),
        };
    };
    return { make, made };
}

describe("a mark's picture", () => {
    const region = { x: 280, y: 180, w: 440, h: 340 };
    const mark = { n: 1, kind: "zone" as const, box: { x: 400, y: 300, w: 200, h: 100 }, path: [] as number[] };
    // A capture at twice the density of the page's CSS pixels.
    const shot = { naturalWidth: 880, naturalHeight: 680 };
    const small = () => "data:image/png;base64,AAAA";

    it("is the capture with the mark drawn where it was, in the capture's own pixels", () => {
        const { make, made } = canvases(small);
        const out = composeCrop(shot, region, mark, cropTier(3), "orange", make);
        expect(out.width).toBe(880);
        expect(out.height).toBe(680);
        expect(made[0].draws[0]).toEqual([0, 0, 880, 680]);
        expect(made[0].labels).toEqual(["1"]);
        expect(out.dataUrl).toMatch(/^data:image\/png;/);
    });

    it("is scaled down to the tier's longer side, and the mark with it", () => {
        const { make, made } = canvases(small);
        const out = composeCrop({ naturalWidth: 2200, naturalHeight: 1700 }, region, mark, cropTier(3), "orange", make);
        expect(Math.max(out.width, out.height)).toBe(1100);
        expect(made[0].draws[0][2]).toBe(1100);
    });

    it("gets smaller tiers as comments get more numerous, so one report always fits", () => {
        const tiers = [cropTier(1), cropTier(6), cropTier(7), cropTier(12), cropTier(13), cropTier(20)];
        expect(tiers.map((t) => t.chars)).toEqual([400_000, 400_000, 240_000, 240_000, 140_000, 140_000]);
        // Twenty comments of the smallest tier, the overview and the reference images stay under the websocket's 10 MB.
        const worst = 20 * cropTier(20).chars + OverviewTier.chars + 8 * 680_000;
        expect(worst).toBeLessThan(10 * 1024 * 1024);
        expect(6 * cropTier(6).chars + OverviewTier.chars + 8 * 680_000).toBeLessThan(10 * 1024 * 1024);
        expect(12 * cropTier(12).chars + OverviewTier.chars + 8 * 680_000).toBeLessThan(10 * 1024 * 1024);
    });

    it("is written as a JPEG when its PNG is longer than the tier allows", () => {
        const long = "data:image/png;base64," + "A".repeat(500_000);
        const { make } = canvases((type) => (type === "image/png" ? long : "data:image/jpeg;base64,BBBB"));
        const out = composeCrop(shot, region, mark, cropTier(1), "orange", make);
        expect(out.dataUrl).toBe("data:image/jpeg;base64,BBBB");
    });

    it("lowers the JPEG's quality, then shrinks the picture, until it fits, and fails when nothing does", () => {
        const long = "x".repeat(500_000);
        const tried: string[] = [];
        const { make, made } = canvases((type, quality, w) => {
            tried.push(`${type}@${quality}:${w}`);
            return type === "image/jpeg" && w < 700 ? "data:image/jpeg;base64,OK" : long;
        });
        const out = composeCrop(shot, region, mark, cropTier(1), "orange", make);
        expect(out.dataUrl).toBe("data:image/jpeg;base64,OK");
        expect(out.width).toBeLessThan(700);
        expect(made.length).toBeGreaterThan(1);
        expect(tried.slice(0, 4)).toEqual([
            "image/png@1:880",
            "image/jpeg@0.85:880",
            "image/jpeg@0.7:880",
            "image/jpeg@0.55:880",
        ]);
        const never = canvases(() => long);
        expect(() => composeCrop(shot, region, mark, cropTier(1), "orange", never.make)).toThrow("too large");
    });

    it("is drawn on white, so a page with no background is not black in a viewer", () => {
        const { make } = canvases(small);
        const fills: string[] = [];
        const wrapped = (w: number, h: number): CanvasLike => {
            const canvas = make(w, h);
            const ctx = canvas.getContext("2d");
            const fillRect = ctx.fillRect;
            ctx.fillRect = (x, y, cw, ch) => {
                fills.push(`${ctx.fillStyle}:${x},${y},${cw},${ch}`);
                fillRect(x, y, cw, ch);
            };
            return canvas;
        };
        composeCrop(shot, region, mark, cropTier(1), "orange", wrapped);
        expect(fills[0]).toBe("white:0,0,880,680");
    });

    it("draws an outline's points relative to the region", () => {
        const { make, made } = canvases(small);
        const outline = {
            n: 4,
            kind: "freehand" as const,
            box: { x: 400, y: 300, w: 100, h: 50 },
            path: [400, 300, 450, 350, 500, 300],
        };
        composeCrop(shot, region, outline, cropTier(1), "orange", make);
        expect(made[0].labels).toEqual(["4"]);
    });
});

describe("the overview of a page", () => {
    const screens = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            image: { naturalWidth: 2000, naturalHeight: 1600 },
            scrollY: Math.min(i * 800, 2500 - 800),
            viewH: 800,
        }));

    it("sets the page's screens one under the other, at their offsets, with the marks numbered on them", () => {
        const { make, made } = canvases(() => "data:image/png;base64,AAAA");
        const out = composeOverview(
            screens(4),
            { w: 1000, h: 2500 },
            [{ n: 1, kind: "zone", box: { x: 100, y: 1200, w: 300, h: 80 }, path: [] }],
            OverviewTier,
            "orange",
            make
        );
        // 1000 x 2500 CSS pixels at twice the density is 2000 x 5000, scaled to a longer side of 2200.
        expect(out.height).toBe(2200);
        expect(out.width).toBe(880);
        const scale = 2200 / 5000;
        expect(made[0].draws.map((d) => d[1])).toEqual([0, 800, 1600, 1700].map((y) => y * 2 * scale));
        expect(made[0].draws.every((d) => d[0] === 0 && d[2] === 880)).toBe(true);
        expect(made[0].labels).toEqual(["1"]);
    });

    it("is a single screen for a page that fits one", () => {
        const { make, made } = canvases(() => "data:image/png;base64,AAAA");
        const out = composeOverview(screens(1), { w: 1000, h: 800 }, [], OverviewTier, "orange", make);
        expect([out.width, out.height]).toEqual([2000, 1600].map((n) => Math.round(n * fitScale(2000, 1600, 2200))));
        expect(made[0].draws).toHaveLength(1);
    });
});

describe("how much a picture keeps", () => {
    it("never scales a picture up, and brings a larger one within the side", () => {
        expect(fitScale(500, 400, 1100)).toBe(1);
        expect(fitScale(2200, 1000, 1100)).toBe(0.5);
        expect(fitScale(0, 0, 1100)).toBe(1);
    });
});
