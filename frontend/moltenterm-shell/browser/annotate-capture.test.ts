// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the review takes of the live page at send time (FR-BRW-017 AC26, #2422): each mark scrolled into view and captured
// with its number, then the overview, then the page put back. A fake page three screens tall, a fake <webview>, fake
// canvases: nothing here waits on a clock.

import { describe, expect, it } from "vitest";
import { type CaptureEnv, captureComments, CropMin, CropPad } from "./annotate-capture";
import type { GuestLink } from "./annotate-guest-link";
import type { CanvasLike, ImageLike } from "./annotate-paint";
import { cropRegion } from "./annotate-anchor";
import { addZone, commitComment, emptyState, type AnnotateState, type Zone } from "./annotate-model";
import type { Anchor, Box, OverviewMessage, PreparedMessage, ToGuest } from "./annotate-wire";

const Page = "http://localhost:3000/shop";
const Viewport = { w: 1000, h: 800 };
const Doc = { w: 1000, h: 2500 };

const anchorAt = (box: Box): Anchor => ({ box, selector: "", rel: null, fixed: false, path: null });

function commented(...marks: { address?: string; box: Box }[]): Zone[] {
    let state: AnnotateState = emptyState();
    for (const mark of marks) {
        state = addZone(state, { kind: "zone", address: mark.address ?? Page, anchor: anchorAt(mark.box) });
        state = commitComment(state, state.editing.id);
    }
    return state.zones;
}

// A page three screens tall that answers the overlay's messages as the real one does, and says what it was asked.
class FakePage {
    log: string[] = [];
    scrollY = 0;
    overviewWhole = true;
    docH = Doc.h;
    fail = new Set<string>();

    request = async <M>(build: (reqId: number) => ToGuest): Promise<M> => {
        const msg = build(this.log.length + 1);
        const reqId = this.log.length + 1;
        if (msg.type === "prepare") {
            this.log.push(`prepare ${msg.id}`);
            if (this.fail.has(`prepare ${msg.id}`)) {
                return { type: "prepared", reqId, ok: false } as unknown as M;
            }
            return this.prepared(reqId, msg.id) as unknown as M;
        }
        if (msg.type === "overview") {
            this.log.push(`overview ${msg.slice}`);
            return this.overview(reqId, msg.slice) as unknown as M;
        }
        if (msg.type === "restore") {
            this.log.push("restore");
            this.scrollY = 0;
            return { type: "restored", reqId } as unknown as M;
        }
        throw new Error(`unexpected ${msg.type}`);
    };

    // Marks are in page coordinates, by id; the page scrolls to centre the one asked.
    marks = new Map<number, Box>();

    prepared(reqId: number, id: number): PreparedMessage {
        const box = this.marks.get(id);
        this.scrollY = Math.max(0, Math.min(this.docH - Viewport.h, Math.round(box.y + box.h / 2 - Viewport.h / 2)));
        return {
            type: "prepared",
            reqId,
            ok: true,
            viewport: Viewport,
            box: { x: box.x, y: box.y - this.scrollY, w: box.w, h: box.h },
            path: [],
            scroll: { x: 0, y: this.scrollY },
        };
    }

    overview(reqId: number, slice: number): OverviewMessage {
        if (slice >= 0) {
            this.scrollY = Math.max(0, Math.min(slice * Viewport.h, this.docH - Viewport.h));
        }
        return {
            type: "overview",
            reqId,
            ok: true,
            viewport: Viewport,
            scroll: { x: 0, y: this.scrollY },
            doc: { w: Doc.w, h: this.docH },
            whole: this.overviewWhole,
            marks: [...this.marks].map(([id, box], i) => ({ id, n: i + 1, kind: "zone", box, path: [] })),
        };
    }
}

type Shot = { x: number; y: number; width: number; height: number };

function makeEnv(page: FakePage, change: Partial<CaptureEnv> = {}) {
    const shots: Shot[] = [];
    const drawn: { w: number; h: number; images: number }[] = [];
    let last: Shot = null;
    const make = (width: number, height: number): CanvasLike => {
        const entry = { w: width, h: height, images: 0 };
        drawn.push(entry);
        const noop = () => {};
        const ctx = {
            fillStyle: "",
            strokeStyle: "",
            lineWidth: 1,
            font: "",
            textAlign: "",
            textBaseline: "",
            globalAlpha: 1,
            fillRect: noop,
            strokeRect: noop,
            beginPath: noop,
            moveTo: noop,
            lineTo: noop,
            arc: noop,
            fill: noop,
            stroke: noop,
            fillText: noop,
            drawImage: () => entry.images++,
        };
        return { width, height, getContext: () => ctx, toDataURL: (type = "image/png") => `data:${type};base64,AAAA` };
    };
    const env: CaptureEnv = {
        link: page as unknown as GuestLink,
        view: {
            capturePage: async (rect) => {
                last = rect;
                shots.push(rect);
                if (page.fail.has("shoot")) {
                    throw new Error("hidden window");
                }
                return { isEmpty: () => false, toDataURL: () => "data:image/png;base64,SHOT" };
            },
            getZoomFactor: () => 1,
        },
        address: Page,
        color: "orange",
        live: () => true,
        // The capture is twice as dense as the page's CSS pixels, as on a high-density display.
        loadImage: async (): Promise<ImageLike> => ({ naturalWidth: last.width * 2, naturalHeight: last.height * 2 }),
        make,
        ...change,
    };
    return { env, shots, drawn };
}

const top: Box = { x: 100, y: 200, w: 300, h: 80 };
const middle: Box = { x: 200, y: 1200, w: 400, h: 200 };
const bottom: Box = { x: 80, y: 2300, w: 500, h: 120 };

function pageWith(zones: Zone[]): FakePage {
    const page = new FakePage();
    zones.forEach((z, i) => page.marks.set(z.id, [top, middle, bottom][i % 3]));
    return page;
}

describe("capturing the comments of a page three screens tall", () => {
    it("scrolls to each mark in turn, captures the region around it, then the page's screens, then puts the page back", async () => {
        const zones = commented({ box: top }, { box: middle }, { box: bottom });
        const page = pageWith(zones);
        const { env, shots } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(page.log).toEqual([
            `prepare ${zones[0].id}`,
            `prepare ${zones[1].id}`,
            `prepare ${zones[2].id}`,
            "overview -1",
            "overview 0",
            "overview 1",
            "overview 2",
            "overview 3",
            "restore",
        ]);
        // Three crops, one per comment, then the four screens of the page: 3 regions around the marks and 4 viewports.
        expect(shots).toHaveLength(7);
        expect(Object.keys(taken.crops).map(Number)).toEqual(zones.map((z) => z.id));
        expect(taken.overview).toMatch(/^data:image\/png;base64,/);
        expect(taken.noOverview).toBe("");
        expect(page.scrollY).toBe(0);
    });

    it("captures, for each mark, the region around it as the page showed it once scrolled to it", async () => {
        const zones = commented({ box: top }, { box: middle }, { box: bottom });
        const page = pageWith(zones);
        const { env, shots } = makeEnv(page);
        await captureComments(env, zones);
        zones.forEach((zone, i) => {
            const mark = [top, middle, bottom][i];
            const scroll = Math.max(0, Math.min(Doc.h - Viewport.h, Math.round(mark.y + mark.h / 2 - Viewport.h / 2)));
            const view = { x: mark.x, y: mark.y - scroll, w: mark.w, h: mark.h };
            const region = cropRegion(view, Viewport, CropPad, CropMin);
            expect(shots[i]).toEqual({ x: region.x, y: region.y, width: region.w, height: region.h });
            // The mark is inside the region it was captured with, whichever screen it was on.
            expect(view.x).toBeGreaterThanOrEqual(region.x);
            expect(view.y + view.h).toBeLessThanOrEqual(region.y + region.h);
        });
    });

    it("takes the overview's screens at the page's own offsets, the last flush with its end", async () => {
        const zones = commented({ box: top });
        const page = pageWith(zones);
        const { env, shots } = makeEnv(page);
        await captureComments(env, zones);
        expect(shots.slice(1)).toEqual([0, 800, 1600, 1700].map(() => ({ x: 0, y: 0, width: 1000, height: 800 })));
    });

    it("scales a capture by the page's zoom", async () => {
        const zones = commented({ box: top });
        const { env, shots } = makeEnv(pageWith(zones));
        env.view.getZoomFactor = () => 1.25;
        await captureComments(env, zones);
        const region = cropRegion({ x: 100, y: 200, w: 300, h: 80 }, Viewport, CropPad, CropMin);
        expect(shots[0]).toEqual({
            x: Math.round(region.x * 1.25),
            y: Math.round(region.y * 1.25),
            width: Math.round(region.w * 1.25),
            height: Math.round(region.h * 1.25),
        });
    });

    it("draws the numbered marks on a canvas as sharp as the capture, down to the picture's longer side", async () => {
        const zones = commented({ box: top });
        const page = pageWith(zones);
        const { env, drawn } = makeEnv(page);
        await captureComments(env, zones);
        const region = cropRegion({ x: 100, y: 200, w: 300, h: 80 }, Viewport, CropPad, CropMin);
        expect(drawn[0]).toEqual({ w: region.w * 2, h: region.h * 2, images: 1 });
        // The overview is 1000 x 2500 CSS pixels at twice the density, scaled to the tier's longer side.
        const overview = drawn[drawn.length - 1];
        expect(Math.max(overview.w, overview.h)).toBeLessThanOrEqual(2200);
        expect(overview.images).toBe(4);
    });
});

describe("what the capture leaves out, and puts back", () => {
    it("captures only the comments of the page shown: the others have no image, their page is gone", async () => {
        const zones = commented({ box: top }, { address: "http://localhost:3000/cart", box: middle }, { box: bottom });
        const page = pageWith(zones);
        const { env } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(Object.keys(taken.crops).map(Number)).toEqual([zones[0].id, zones[2].id]);
        expect(page.log.filter((l) => l.startsWith("prepare"))).toEqual([`prepare ${zones[0].id}`, `prepare ${zones[2].id}`]);
    });

    it("numbers a mark as the report does: by its place in the whole list", async () => {
        const zones = commented({ address: "http://localhost:3000/cart", box: middle }, { box: top });
        const { env, drawn } = makeEnv(pageWith(zones));
        const painted: number[] = [];
        const original = env.make;
        env.make = (w, h) => {
            const canvas = original(w, h);
            const ctx = canvas.getContext("2d");
            const fillText = ctx.fillText;
            ctx.fillText = (text, x, y) => {
                painted.push(Number(text));
                fillText(text, x, y);
            };
            return canvas;
        };
        await captureComments(env, zones);
        expect(painted[0]).toBe(2);
        expect(drawn.length).toBeGreaterThan(0);
    });

    it("captures nothing, and does not touch the page, when no comment is on the page shown", async () => {
        const zones = commented({ address: "http://localhost:3000/cart", box: middle });
        const page = pageWith(zones);
        const { env } = makeEnv(page);
        expect(await captureComments(env, zones)).toEqual({ crops: {}, overview: "", noOverview: "none" });
        expect(page.log).toEqual([]);
    });

    it("puts the page back, and goes on with the other marks, when one cannot be captured", async () => {
        const zones = commented({ box: top }, { box: middle });
        const page = pageWith(zones);
        page.fail.add(`prepare ${zones[0].id}`);
        const { env } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(Object.keys(taken.crops).map(Number)).toEqual([zones[1].id]);
        expect(page.log[page.log.length - 1]).toBe("restore");
    });

    it("gives no image, and still puts the page back, when the page cannot be captured at all", async () => {
        const zones = commented({ box: top }, { box: middle });
        const page = pageWith(zones);
        page.fail.add("shoot");
        const { env } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(taken).toEqual({ crops: {}, overview: "", noOverview: "failed" });
        expect(page.log[page.log.length - 1]).toBe("restore");
    });

    it("stops asking the page once the review is left, and still puts it back", async () => {
        const zones = commented({ box: top }, { box: middle }, { box: bottom });
        const page = pageWith(zones);
        let calls = 0;
        const { env } = makeEnv(page, { live: () => ++calls <= 1 });
        const taken = await captureComments(env, zones);
        expect(Object.keys(taken.crops)).toHaveLength(1);
        expect(page.log).toEqual([`prepare ${zones[0].id}`, "restore"]);
    });

    it("reports how far it got", async () => {
        const zones = commented({ box: top }, { box: middle });
        const steps: string[] = [];
        const { env } = makeEnv(pageWith(zones), { onProgress: (done, total) => steps.push(`${done}/${total}`) });
        await captureComments(env, zones);
        expect(steps).toEqual(["0/3", "1/3", "2/3", "3/3"]);
    });
});

describe("the page's overview, where the page allows it", () => {
    it("is not taken for a page that scrolls inside one of its areas, and says why", async () => {
        const zones = commented({ box: top });
        const page = pageWith(zones);
        page.overviewWhole = false;
        const { env } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(taken.overview).toBe("");
        expect(taken.noOverview).toBe("inner");
        expect(page.log.filter((l) => l.startsWith("overview"))).toEqual(["overview -1"]);
    });

    it("is not taken for a page taller than twelve screens, and says why", async () => {
        const zones = commented({ box: top });
        const page = pageWith(zones);
        page.overviewWhole = false;
        page.docH = Viewport.h * 13;
        const { env } = makeEnv(page);
        expect((await captureComments(env, zones)).noOverview).toBe("tall");
    });

    it("is one screen for a page that fits one", async () => {
        const zones = commented({ box: { x: 10, y: 10, w: 100, h: 50 } });
        const page = pageWith(zones);
        page.docH = 600;
        const { env, shots } = makeEnv(page);
        const taken = await captureComments(env, zones);
        expect(page.log.filter((l) => l.startsWith("overview "))).toEqual(["overview -1", "overview 0"]);
        expect(shots).toHaveLength(2);
        expect(taken.noOverview).toBe("");
    });
});
