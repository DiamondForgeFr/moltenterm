// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The reference images of a comment (FR-BRW-017 AC21, #2327): what is checked before decoding, what a paste or a drop
// gives, and the image written again.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    checkRefSource,
    fitRefSize,
    imageBlobs,
    MaxRefChars,
    MaxRefSourceBytes,
    prepareReference,
    RefError,
    RefSides,
} from "./annotate-refs";

function blob(type: string, size: number): Blob {
    return { type, size } as Blob;
}

function file(name: string, type: string): File {
    return { name, type, size: 10 } as File;
}

describe("what is checked before an image is decoded", () => {
    it("takes png, jpeg, webp and gif, whatever the case of their type", () => {
        for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "IMAGE/PNG"]) {
            expect(checkRefSource(type, 1000)).toBeNull();
        }
    });

    it("refuses any other type: svg, bmp, a document, a script, nothing", () => {
        for (const type of [
            "image/svg+xml",
            "image/bmp",
            "application/pdf",
            "text/html",
            "application/javascript",
            "",
        ]) {
            expect(checkRefSource(type, 1000)).toBe("type");
        }
    });

    it("refuses an image that is empty or over the limit, by its size alone", () => {
        expect(checkRefSource("image/png", 0)).toBe("size");
        expect(checkRefSource("image/png", MaxRefSourceBytes)).toBeNull();
        expect(checkRefSource("image/png", MaxRefSourceBytes + 1)).toBe("size");
    });
});

describe("what a paste or a drop gives", () => {
    it("is the image files of the event itself, in order", () => {
        const a = file("a.png", "image/png");
        const b = file("b.txt", "text/plain");
        const c = file("c.gif", "image/gif");
        expect(imageBlobs({ files: [a, b, c] })).toEqual([a, c]);
    });

    it("is the file items of a paste that has no files, images only", () => {
        const pasted = file("image.png", "image/png");
        const item = (kind: string, type: string, f: File = null) => ({ kind, type, getAsFile: () => f });
        const got = imageBlobs({
            items: [
                item("string", "text/plain"),
                item("file", "image/png", pasted),
                item("file", "application/pdf", file("x.pdf", "application/pdf")),
            ],
        });
        expect(got).toEqual([pasted]);
    });

    it("never reads a path: only File objects of the event, whatever their name says", () => {
        const sneaky = file("/etc/passwd", "image/png");
        expect(imageBlobs({ files: [sneaky] })).toEqual([sneaky]);
        expect(imageBlobs({ files: [file("/etc/passwd", "text/plain")] })).toEqual([]);
        expect(imageBlobs(null)).toEqual([]);
        expect(imageBlobs({})).toEqual([]);
    });
});

describe("fitRefSize", () => {
    it("scales the longer side down to the limit and never up", () => {
        expect(fitRefSize(2560, 1280, 1280)).toEqual({ w: 1280, h: 640 });
        expect(fitRefSize(600, 2400, 1280)).toEqual({ w: 320, h: 1280 });
        expect(fitRefSize(300, 200, 1280)).toEqual({ w: 300, h: 200 });
    });
});

describe("prepareReference", () => {
    afterEach(() => vi.unstubAllGlobals());

    type Canvas = { width: number; height: number };
    function stubDom(
        options: { png?: (w: number) => number; jpeg?: (w: number, q: number) => number; fail?: boolean } = {}
    ) {
        const decode = vi.fn(async () => {
            if (options.fail) {
                throw new Error("not an image");
            }
            return bitmap;
        });
        const bitmap = { width: 3000, height: 2000, close: vi.fn() };
        const ops: string[] = [];
        const dataUrls: string[] = [];
        vi.stubGlobal("createImageBitmap", decode);
        vi.stubGlobal("document", {
            createElement: () => {
                const canvas: Canvas & Record<string, unknown> = {
                    width: 0,
                    height: 0,
                    getContext: () => ({
                        fillRect: () => ops.push("fillRect"),
                        drawImage: () => ops.push("drawImage"),
                    }),
                    toDataURL: (type: string, quality?: number) => {
                        const length =
                            type === "image/png"
                                ? (options.png ?? (() => 1000))(canvas.width)
                                : (options.jpeg ?? (() => 1000))(canvas.width, quality);
                        const url = `data:${type};base64,` + "A".repeat(length);
                        dataUrls.push(`${type} ${canvas.width}x${canvas.height} q${quality ?? "-"}`);
                        return url;
                    },
                };
                return canvas;
            },
        });
        return { decode, bitmap, ops, dataUrls };
    }

    it("refuses what is not an image of a taken type, or is too large, before anything decodes it", async () => {
        const dom = stubDom();
        await expect(prepareReference(blob("image/svg+xml", 100))).rejects.toMatchObject({ reason: "type" });
        await expect(prepareReference(blob("image/png", MaxRefSourceBytes + 1))).rejects.toMatchObject({
            reason: "size",
        });
        expect(dom.decode).not.toHaveBeenCalled();
    });

    it("says an image that cannot be read", async () => {
        stubDom({ fail: true });
        const error = await prepareReference(blob("image/png", 100)).catch((e) => e);
        expect(error).toBeInstanceOf(RefError);
        expect(error.reason).toBe("decode");
    });

    it("writes the image again as a png, scaled down, on a white ground, and lets go of the decoded image", async () => {
        const dom = stubDom();
        const url = await prepareReference(blob("image/gif", 5000));
        expect(url.startsWith("data:image/png;base64,")).toBe(true);
        expect(dom.dataUrls).toEqual([`image/png ${RefSides[0]}x${Math.round((RefSides[0] * 2000) / 3000)} q-`]);
        expect(dom.ops).toEqual(["fillRect", "drawImage"]);
        expect(dom.bitmap.close).toHaveBeenCalled();
    });

    it("falls back to a jpeg when the png is too large, then to a smaller image, and gives up when none is small enough", async () => {
        const jpegDom = stubDom({ png: () => MaxRefChars + 1, jpeg: (_w, q) => (q === 0.85 ? MaxRefChars + 1 : 1000) });
        const jpeg = await prepareReference(blob("image/jpeg", 5000));
        expect(jpeg.startsWith("data:image/jpeg;base64,")).toBe(true);
        expect(jpegDom.dataUrls.map((d) => d.split(" ")[0])).toEqual(["image/png", "image/jpeg", "image/jpeg"]);
        vi.unstubAllGlobals();

        const smaller = stubDom({ png: (w) => (w > 1000 ? MaxRefChars + 1 : 1000), jpeg: () => MaxRefChars + 1 });
        const url = await prepareReference(blob("image/png", 5000));
        expect(url.startsWith("data:image/png;base64,")).toBe(true);
        expect(smaller.dataUrls.some((d) => d.includes("x"))).toBe(true);
        vi.unstubAllGlobals();

        const never = stubDom({ png: () => MaxRefChars + 1, jpeg: () => MaxRefChars + 1 });
        await expect(prepareReference(blob("image/png", 5000))).rejects.toMatchObject({ reason: "large" });
        expect(never.dataUrls.length).toBe(RefSides.length * 3);
        expect(never.bitmap.close).toHaveBeenCalled();
    });
});
