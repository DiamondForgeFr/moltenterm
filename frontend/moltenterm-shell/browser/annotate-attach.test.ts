// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the comment field does with a paste, a drop and the images they give (FR-BRW-017 AC21, #2327): the size an
// image declares is read from its header before anything decodes it, a drop of anything but files is left alone, and the
// images are attached in turn within the room a zone and a report have.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nModel, t } from "../i18n/i18n";
import {
    addZone,
    type AnnotateState,
    commitComment,
    emptyState,
    MaxRefs,
    MaxRefsPerZone,
    type Placed,
    refCount,
    refTitleTemplate,
} from "./annotate-model";
import {
    attachReferences,
    carriesFiles,
    dropHandling,
    fieldDragOver,
    fieldDrop,
    fieldPaste,
    MaxRefPixels,
    pasteHandling,
    prepareReference,
    readImageSize,
    RefError,
    RefHeaderBytes,
} from "./annotate-refs";

const Box: Placed = {
    kind: "zone",
    address: "http://localhost:5173/shop",
    anchor: { box: { x: 100, y: 200, w: 300, h: 150 }, selector: "", rel: null, fixed: false, path: null },
};

function png(w: number, h: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
}

function gif(w: number, h: number): Uint8Array {
    const b = new Uint8Array(13);
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    new DataView(b.buffer).setUint16(6, w, true);
    new DataView(b.buffer).setUint16(8, h, true);
    return b;
}

// A jpeg with a comment segment before its frame header: the size is read past it.
function jpeg(w: number, h: number, padding = 300): Uint8Array {
    const b = new Uint8Array(2 + 4 + padding + 19);
    b.set([0xff, 0xd8, 0xff, 0xfe, (padding + 2) >> 8, (padding + 2) & 0xff], 0);
    const sof = 2 + 4 + padding;
    b.set([0xff, 0xc2, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3], sof);
    return b;
}

function webp(kind: "VP8 " | "VP8L" | "VP8X", w: number, h: number): Uint8Array {
    const b = new Uint8Array(40);
    b.set([...("RIFF" + "\0\0\0\0" + "WEBP" + kind).split("").map((c) => c.charCodeAt(0))]);
    if (kind === "VP8 ") {
        b.set([0x9d, 0x01, 0x2a], 23);
        b[26] = w & 0xff;
        b[27] = (w >> 8) & 0x3f;
        b[28] = h & 0xff;
        b[29] = (h >> 8) & 0x3f;
    } else if (kind === "VP8L") {
        b[20] = 0x2f;
        const bits = (w - 1) | ((h - 1) << 14);
        b.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
    } else {
        const cw = w - 1;
        const ch = h - 1;
        b.set([cw & 0xff, (cw >> 8) & 0xff, (cw >> 16) & 0xff, ch & 0xff, (ch >> 8) & 0xff, (ch >> 16) & 0xff], 24);
    }
    return b;
}

describe("the size an image declares, read from its header", () => {
    it("is read for each format, whatever the type the file claims", () => {
        expect(readImageSize(png(1920, 1080))).toEqual({ w: 1920, h: 1080 });
        expect(readImageSize(gif(640, 480))).toEqual({ w: 640, h: 480 });
        expect(readImageSize(jpeg(4000, 3000))).toEqual({ w: 4000, h: 3000 });
        expect(readImageSize(webp("VP8 ", 800, 600))).toEqual({ w: 800, h: 600 });
        expect(readImageSize(webp("VP8L", 1000, 700))).toEqual({ w: 1000, h: 700 });
        expect(readImageSize(webp("VP8X", 30000, 20000))).toEqual({ w: 30000, h: 20000 });
    });

    it("is null where no size can be read: another format, a truncated header, nothing", () => {
        expect(readImageSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
        expect(readImageSize(png(10, 10).slice(0, 20))).toBeNull();
        expect(readImageSize(jpeg(10, 10).slice(0, 100))).toBeNull();
        expect(readImageSize(new Uint8Array(0))).toBeNull();
        expect(readImageSize(new Uint8Array(64))).toBeNull();
    });
});

describe("prepareReference reads the declared size before it decodes", () => {
    afterEach(() => vi.unstubAllGlobals());

    // A few bytes that declare more pixels than the window decodes, however small the file.
    function file(type: string, head: Uint8Array, size = head.length): Blob {
        return { type, size, slice: () => ({ arrayBuffer: async () => head.buffer }) } as unknown as Blob;
    }

    it.each([
        ["a png", "image/png", png(30000, 30000)],
        ["a gif", "image/gif", gif(65535, 65535)],
        ["a jpeg", "image/jpeg", jpeg(20000, 20000)],
        ["a webp, extended", "image/webp", webp("VP8X", 30000, 30000)],
        ["a webp, lossless", "image/webp", webp("VP8L", 16384, 16384)],
        ["a webp, lossy", "image/webp", webp("VP8 ", 16383, 16383)],
        ["a png whose type says webp", "image/webp", png(30000, 30000)],
    ])("refuses %s that declares too many pixels, and decodes nothing", async (_name, type, head) => {
        const decode = vi.fn();
        vi.stubGlobal("createImageBitmap", decode);
        const error = await prepareReference(file(type, head)).catch((e) => e);
        expect(error).toBeInstanceOf(RefError);
        expect(error.reason).toBe("large");
        expect(decode).not.toHaveBeenCalled();
    });

    it("refuses a header that says no size, or a size of zero, as unreadable, and decodes nothing", async () => {
        const decode = vi.fn();
        vi.stubGlobal("createImageBitmap", decode);
        for (const head of [new Uint8Array(64), png(0, 10), png(10, 0)]) {
            const error = await prepareReference(file("image/png", head)).catch((e) => e);
            expect(error.reason).toBe("decode");
        }
        const empty = await prepareReference(file("image/png", png(10, 10), 0)).catch((e) => e);
        expect(empty.reason).toBe("decode");
        expect(decode).not.toHaveBeenCalled();
    });

    it("reads the header of a file as large as the limit allows, and no more than a header's worth of it", async () => {
        const slice = vi.fn(() => ({ arrayBuffer: async () => png(100, 100).buffer }));
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => {
                throw new Error("stop here");
            })
        );
        const big = { type: "image/png", size: 5 * 1024 * 1024, slice } as unknown as Blob;
        await prepareReference(big).catch(() => {});
        expect(slice).toHaveBeenCalledWith(0, RefHeaderBytes);
    });

    it("keeps the limit in pixels: a picture right at it is decoded", () => {
        expect(MaxRefPixels).toBe(40_000_000);
        expect(readImageSize(png(8000, 5000))).toEqual({ w: 8000, h: 5000 });
        expect(8000 * 5000).toBeLessThanOrEqual(MaxRefPixels);
    });
});

describe("what the field does with a drop", () => {
    const f = (name: string, type: string) => ({ name, type, size: 10 }) as File;

    it("takes a drop of files only: a dragged text, an address, or the move of a text inside the field is the browser's", () => {
        for (const types of [["text/plain"], ["text/uri-list", "text/plain"], ["text/html"], []]) {
            expect(carriesFiles({ types })).toBe(false);
            expect(dropHandling({ types, files: [] })).toEqual({ claim: false, images: [], others: 0 });
        }
        expect(carriesFiles({ types: ["Files"] })).toBe(true);
        expect(carriesFiles(null)).toBe(false);
        expect(carriesFiles({})).toBe(false);
    });

    it("attaches the images of a drop of files and counts the files that are none", () => {
        const a = f("a.png", "image/png");
        const c = f("c.gif", "image/gif");
        const drop = dropHandling({
            types: ["Files"],
            files: [a, f("b.txt", "text/plain"), c, f("d.pdf", "application/pdf")],
        });
        expect(drop).toEqual({ claim: true, images: [a, c], others: 2 });
    });

    it("takes a drop of files that holds no image too, to say so instead of opening the file", () => {
        expect(dropHandling({ types: ["Files"], files: [f("b.txt", "text/plain")] })).toEqual({
            claim: true,
            images: [],
            others: 1,
        });
    });

    it("takes a paste only when it holds an image: a pasted text is the field's own", () => {
        const pasted = f("image.png", "image/png");
        const item = (kind: string, type: string, file: File = null) => ({ kind, type, getAsFile: () => file });
        expect(pasteHandling({ items: [item("string", "text/plain")] })).toEqual({ claim: false, images: [] });
        expect(pasteHandling({ items: [item("file", "image/png", pasted)] })).toEqual({
            claim: true,
            images: [pasted],
        });
        expect(pasteHandling({ files: [f("b.txt", "text/plain")] })).toEqual({ claim: false, images: [] });
        expect(pasteHandling(null)).toEqual({ claim: false, images: [] });
    });
});

// The handlers the comment field is given: what each does to the event, which is where a text dragged into the field, or
// moved inside it, was once swallowed.
describe("the comment field's drag, drop and paste handlers", () => {
    const f = (name: string, type: string) => ({ name, type, size: 10 }) as File;

    function event(extra: object) {
        const prevented = { count: 0 };
        return { prevented, e: { preventDefault: () => prevented.count++, ...extra } };
    }

    it("leave a dragged text, an address and the move of a text inside the field to the browser", () => {
        for (const types of [["text/plain"], ["text/uri-list", "text/plain"], ["text/html", "text/plain"], []]) {
            const over = event({ dataTransfer: { types } });
            fieldDragOver(over.e);
            const drop = event({ dataTransfer: { types, files: [] } });
            const attach = vi.fn();
            fieldDrop(drop.e, attach);
            expect([types, over.prevented.count, drop.prevented.count, attach.mock.calls.length]).toEqual([
                types,
                0,
                0,
                0,
            ]);
        }
    });

    it("take a drop of files: the drag is allowed, the drop is claimed, the images are attached", () => {
        const a = f("a.png", "image/png");
        const dataTransfer = { types: ["Files"], files: [a, f("b.txt", "text/plain")] };
        const over = event({ dataTransfer });
        fieldDragOver(over.e);
        expect(over.prevented.count).toBe(1);
        const drop = event({ dataTransfer });
        const attach = vi.fn();
        fieldDrop(drop.e, attach);
        expect(drop.prevented.count).toBe(1);
        expect(attach).toHaveBeenCalledWith([a], 1);
    });

    it("take a drop of a file that is no image too, so that it is not opened in place of the app, and say so", () => {
        const drop = event({ dataTransfer: { types: ["Files"], files: [f("b.pdf", "application/pdf")] } });
        const attach = vi.fn();
        fieldDrop(drop.e, attach);
        expect(drop.prevented.count).toBe(1);
        expect(attach).toHaveBeenCalledWith([], 1);
    });

    it("take a paste of an image and leave a pasted text to the field", () => {
        const pasted = f("image.png", "image/png");
        const image = event({ clipboardData: { files: [pasted], types: ["Files"] } });
        const attach = vi.fn();
        fieldPaste(image.e, attach);
        expect(image.prevented.count).toBe(1);
        expect(attach).toHaveBeenCalledWith([pasted], 0);
        const text = event({ clipboardData: { files: [], types: ["text/plain"] } });
        const none = vi.fn();
        fieldPaste(text.e, none);
        expect([text.prevented.count, none.mock.calls.length]).toEqual([0, 0]);
        const bare = event({});
        fieldPaste(bare.e, none);
        expect(bare.prevented.count).toBe(0);
    });
});

// No DOM here to fire an event at the field: the layer's source says which handlers it is given, and that it keeps none
// of its own that would swallow a drop.
const LayerSource = readFileSync(new URL("./annotate-layer.tsx", import.meta.url), "utf8");

describe("the comment field of the layer", () => {
    it("is given the handlers above, and no handler of its own on a drag, a drop or a paste", () => {
        expect(LayerSource).toContain("onDragOver={fieldDragOver}");
        expect(LayerSource).toContain("onDrop={(e) => fieldDrop(e, onAttach)}");
        expect(LayerSource).toContain("onPaste={(e) => fieldPaste(e, onAttach)}");
        expect(LayerSource.match(/onDragOver=|onDrop=|onPaste=/g)).toHaveLength(3);
    });
});

describe("attaching the images of a paste or a drop to a zone", () => {
    const Data = (n: number) => `data:image/png;base64,AAAA${n}`;

    function zone(): { id: number; deps: ReturnType<typeof makeDeps> } {
        const state = addZone(emptyState(), Box);
        return { id: state.zones[0].id, deps: makeDeps(state) };
    }

    function makeDeps(initial: AnnotateState, prepare?: (b: Blob) => Promise<string>) {
        const box = { state: initial };
        return {
            box,
            getState: () => box.state,
            setState: (s: AnnotateState) => (box.state = s),
            prepare: prepare ?? (async () => Data(box.state.nextRefId)),
        };
    }

    const file = (name: string) => ({ name }) as unknown as Blob;

    it("attaches each image in turn, and says nothing when all are", async () => {
        const { id, deps } = zone();
        expect(await attachReferences(id, [file("a"), file("b")], 0, deps)).toBeNull();
        expect(deps.box.state.zones[0].refs).toHaveLength(2);
    });

    it("asks whether the zone has room before an image is prepared, so that none is decoded for nothing", async () => {
        const { id, deps } = zone();
        const prepare = vi.fn(deps.prepare);
        deps.prepare = prepare;
        const files = Array.from({ length: MaxRefsPerZone + 2 }, (_, i) => file(String(i)));
        expect(await attachReferences(id, files, 0, deps)).toBe("zone");
        expect(deps.box.state.zones[0].refs).toHaveLength(MaxRefsPerZone);
        expect(prepare).toHaveBeenCalledTimes(MaxRefsPerZone);
        prepare.mockClear();
        expect(await attachReferences(id, [file("x")], 0, deps)).toBe("zone");
        expect(prepare).not.toHaveBeenCalled();
    });

    it("holds the report's limit too, across zones, before preparing", async () => {
        let state = emptyState();
        for (let z = 0; z < 3; z++) {
            state = commitComment(addZone(state, Box), state.nextId);
        }
        const deps = makeDeps(state);
        const prepare = vi.fn(deps.prepare);
        deps.prepare = prepare;
        for (let z = 0; z < 2; z++) {
            expect(
                await attachReferences(state.zones[z].id, Array(MaxRefsPerZone).fill(file("f")), 0, deps)
            ).toBeNull();
        }
        expect(refCount(deps.box.state)).toBe(MaxRefs);
        prepare.mockClear();
        expect(await attachReferences(state.zones[2].id, [file("x")], 0, deps)).toBe("report");
        expect(prepare).not.toHaveBeenCalled();
    });

    it("leaves out an image that cannot be prepared, attaches the others and says why", async () => {
        const { id, deps } = zone();
        deps.prepare = async (b) => {
            if ((b as unknown as { name: string }).name === "bad") {
                throw new RefError("large");
            }
            return Data(1);
        };
        expect(await attachReferences(id, [file("bad"), file("good")], 0, deps)).toBe("large");
        expect(deps.box.state.zones[0].refs).toHaveLength(1);
        deps.prepare = async () => {
            throw new Error("something else");
        };
        expect(await attachReferences(id, [file("x")], 0, deps)).toBe("decode");
    });

    it("says a dropped file that is no image was left out, when nothing else is to be said", async () => {
        const { id, deps } = zone();
        expect(await attachReferences(id, [], 1, deps)).toBe("notimage");
        expect(await attachReferences(id, [file("a")], 1, deps)).toBe("notimage");
        expect(deps.box.state.zones[0].refs).toHaveLength(1);
        deps.prepare = async () => {
            throw new RefError("type");
        };
        expect(await attachReferences(id, [file("x")], 1, deps)).toBe("type");
        expect(await attachReferences(id, [], 0, deps)).toBeNull();
    });
});

// wavesrv fills {zone} and {n} in the title of a reference's material: the template reaches it with both, in each language.
describe("the title of a reference image's material", () => {
    afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

    it.each(["en", "fr"])("keeps {zone} and {n} for wavesrv to fill, in %s", (language) => {
        I18nModel.getInstance().setLanguageSetting(language);
        const template = refTitleTemplate(t);
        expect(template).toContain("{zone}");
        expect(template).toContain("{n}");
        expect(template.replace("{zone}", "2").replace("{n}", "1")).not.toMatch(/[{}]/);
    });

    it("reads as a title in each language", () => {
        expect(refTitleTemplate(t)).toBe("Commented page, comment {zone}: reference {n}");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(refTitleTemplate(t)).toBe("Page commentée, commentaire {zone} : référence {n}");
    });
});
