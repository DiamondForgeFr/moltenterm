// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The annotated image (FR-BRW-017 AC12, #2327): each zone framed and numbered into the capture, scaled to what is sent.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Zone } from "./annotate-model";
import { composeAnnotatedImage, fitSize, type Paint2D, paintZones } from "./annotate-paint";

type Call = [string, ...unknown[]];

// A context that records what is drawn, with the style it was drawn in.
function recorder(): { ctx: Paint2D; calls: Call[] } {
    const calls: Call[] = [];
    const style = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        font: "",
        textAlign: "",
        textBaseline: "",
        globalAlpha: 1,
    };
    const ctx = new Proxy(style, {
        get(target, name: string) {
            if (name in target) {
                return target[name as keyof typeof target];
            }
            return (...args: unknown[]) =>
                calls.push([name, ...args, { fill: target.fillStyle, stroke: target.strokeStyle }]);
        },
        set(target, name: string, value) {
            target[name as keyof typeof target] = value as never;
            return true;
        },
    }) as unknown as Paint2D;
    return { ctx, calls };
}

const Zones: Zone[] = [
    { id: 7, x: 0.1, y: 0.2, w: 0.3, h: 0.25, comment: "one" },
    { id: 9, x: 0.6, y: 0.5, w: 0.2, h: 0.2, comment: "two" },
];

describe("paintZones", () => {
    it("frames each zone in the colour and writes its number on a badge, in the order of the report", () => {
        const { ctx, calls } = recorder();
        paintZones(ctx, Zones, { w: 1000, h: 500 }, "orange");
        const frames = calls.filter((c) => c[0] === "strokeRect").map((c) => c.slice(1, 5));
        expect(frames).toEqual([
            [100, 100, 300, 125],
            [600, 250, 200, 100],
        ]);
        expect(calls.filter((c) => c[0] === "fillText").map((c) => c[1])).toEqual(["1", "2"]);
        expect(
            calls.filter((c) => c[0] === "strokeRect").every((c) => (c[5] as { stroke: string }).stroke === "orange")
        ).toBe(true);
    });

    it("keeps a badge inside the image when its zone starts at the edge", () => {
        const { ctx, calls } = recorder();
        paintZones(ctx, [{ id: 1, x: 0, y: 0, w: 0.5, h: 0.5, comment: "" }], { w: 400, h: 300 }, "orange");
        const arc = calls.find((c) => c[0] === "arc");
        const [x, y, r] = arc.slice(1, 4) as number[];
        expect(x - r).toBeGreaterThanOrEqual(0);
        expect(y - r).toBeGreaterThanOrEqual(0);
    });

    it("grows the frames and badges with the image so they read at any size", () => {
        const small = recorder();
        const large = recorder();
        paintZones(small.ctx, Zones, { w: 500, h: 300 }, "orange");
        paintZones(large.ctx, Zones, { w: 2000, h: 1200 }, "orange");
        const radius = (calls: Call[]) => calls.find((c) => c[0] === "arc")[3] as number;
        expect(radius(large.calls)).toBeGreaterThan(radius(small.calls));
    });

    it("draws nothing for no zone", () => {
        const { ctx, calls } = recorder();
        paintZones(ctx, [], { w: 100, h: 100 }, "orange");
        expect(calls).toEqual([]);
    });
});

describe("fitSize", () => {
    it("scales the longer side down to the limit and never up", () => {
        expect(fitSize(3200, 1600, 1600)).toEqual({ w: 1600, h: 800 });
        expect(fitSize(800, 2400, 1600)).toEqual({ w: 533, h: 1600 });
        expect(fitSize(640, 480, 1600)).toEqual({ w: 640, h: 480 });
    });
});

describe("composeAnnotatedImage", () => {
    afterEach(() => vi.unstubAllGlobals());

    // A page of 3000 x 2000 pixels, a canvas whose PNG is as long as the test says for each size.
    function stubDom(pngLength: (width: number) => number) {
        const drawn: { w: number; h: number; text: string[]; ops: string[] }[] = [];
        vi.stubGlobal(
            "Image",
            class {
                naturalWidth = 3000;
                naturalHeight = 2000;
                onload: () => void = null;
                onerror: () => void = null;
                set src(_: string) {
                    queueMicrotask(() => this.onload());
                }
            }
        );
        vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => " rgb(255, 106, 0) " }));
        vi.stubGlobal("document", {
            createElement: () => {
                const text: string[] = [];
                const ops: string[] = [];
                const canvas = {
                    width: 0,
                    height: 0,
                    getContext: () => ({
                        drawImage: () => ops.push("drawImage"),
                        fillRect: () => ops.push("fillRect"),
                        strokeRect: () => {},
                        beginPath: () => {},
                        arc: () => {},
                        fill: () => {},
                        stroke: () => {},
                        fillText: (s: string) => text.push(s),
                    }),
                    toDataURL: () => {
                        drawn.push({ w: canvas.width, h: canvas.height, text, ops });
                        return "data:image/png;base64," + "A".repeat(pngLength(canvas.width));
                    },
                };
                return canvas;
            },
            documentElement: {},
        });
        return drawn;
    }

    it("draws the zones on the capture scaled to the limit and answers its PNG", async () => {
        const drawn = stubDom(() => 1000);
        const out = await composeAnnotatedImage("data:image/png;base64,x", Zones);
        expect(out).toMatchObject({ width: 1600, height: 1067 });
        expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].text).toEqual(["1", "2"]);
    });

    it("lays the page over a white ground, so a page with no background of its own is not black in a viewer", async () => {
        const drawn = stubDom(() => 1000);
        await composeAnnotatedImage("data:image/png;base64,x", Zones);
        expect(drawn[0].ops.slice(0, 2)).toEqual(["fillRect", "drawImage"]);
    });

    it("draws again smaller while the PNG is too large to send", async () => {
        const drawn = stubDom((width) => (width > 1000 ? 5_000_000 : 1000));
        const out = await composeAnnotatedImage("data:image/png;base64,x", Zones);
        expect(drawn.length).toBeGreaterThan(1);
        expect(out.width).toBeLessThanOrEqual(1000);
    });

    it("gives up when no size is small enough", async () => {
        stubDom(() => 5_000_000);
        await expect(composeAnnotatedImage("data:image/png;base64,x", Zones)).rejects.toThrow();
    });
});
