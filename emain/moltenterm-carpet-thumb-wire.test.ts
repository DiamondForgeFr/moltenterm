// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ThumbMaxFileBytes } from "./moltenterm-carpet-thumb-store";
import {
    parseThumbPut,
    parseThumbReadItems,
    parseThumbRemoveKeys,
    thumbAnswer,
    ThumbMaxItems,
} from "./moltenterm-carpet-thumb-wire";

const jpegUrl = (data: Buffer) => "data:image/jpeg;base64," + data.toString("base64");

describe("parseThumbPut", () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const good = { key: "block-1", tag: "block-1@https://a.dev/", url: jpegUrl(body), width: 640, height: 400, at: 5 };

    it("decodes a JPEG data URL for a valid key and tag", () => {
        const put = parseThumbPut(good);
        expect(put).toMatchObject({ key: "block-1", tag: "block-1@https://a.dev/", width: 640, height: 400, at: 5 });
        expect(put.data.equals(body)).toBe(true);
    });

    it("refuses what is not a small JPEG for a valid key", () => {
        expect(parseThumbPut(null)).toBeNull();
        expect(parseThumbPut({ ...good, key: "../x" })).toBeNull();
        expect(parseThumbPut({ ...good, key: "" })).toBeNull();
        expect(parseThumbPut({ ...good, tag: 5 })).toBeNull();
        expect(parseThumbPut({ ...good, tag: "x".repeat(5000) })).toBeNull();
        expect(parseThumbPut({ ...good, url: "data:image/png;base64,AAAA" })).toBeNull();
        expect(parseThumbPut({ ...good, url: "https://a.dev/x.jpg" })).toBeNull();
        expect(parseThumbPut({ ...good, url: "data:image/jpeg;base64," })).toBeNull();
        expect(parseThumbPut({ ...good, url: jpegUrl(Buffer.alloc(ThumbMaxFileBytes + 1, 1)) })).toBeNull();
    });
});

describe("parseThumbReadItems and parseThumbRemoveKeys", () => {
    it("keeps the valid items only, and at most ThumbMaxItems", () => {
        expect(parseThumbReadItems("nope")).toEqual([]);
        expect(
            parseThumbReadItems([
                { key: "a", tag: "t" },
                { key: "../b", tag: "t" },
                { key: "c" },
                null,
                { key: "d", tag: "u" },
            ])
        ).toEqual([
            { key: "a", tag: "t" },
            { key: "d", tag: "u" },
        ]);
        const many = Array.from({ length: ThumbMaxItems + 50 }, (_, i) => ({ key: `k${i}`, tag: "t" }));
        expect(parseThumbReadItems(many)).toHaveLength(ThumbMaxItems);
        expect(parseThumbRemoveKeys(["a", "../b", 4, "c"])).toEqual(["a", "c"]);
        expect(parseThumbRemoveKeys(undefined)).toEqual([]);
    });
});

describe("thumbAnswer", () => {
    it("gives each stored thumbnail back as a JPEG data URL", () => {
        const data = Buffer.from([0xff, 0xd8, 0xff, 9]);
        expect(thumbAnswer({ a: { data, width: 640, height: 300, at: 7 } })).toEqual({
            a: { url: jpegUrl(data), width: 640, height: 300, at: 7 },
        });
    });
});
