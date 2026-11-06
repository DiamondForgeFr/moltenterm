// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { FaviconMaxBytes } from "./moltenterm-favicon-store";
import {
    decodeInlineIcon,
    faviconAnswer,
    FaviconMaxRead,
    iconDataUrl,
    isInlineIcon,
    originOfPage,
    parseFaviconOrigins,
    parseMeasured,
    pickIconAddress,
    sniffIcon,
    validOrigin,
} from "./moltenterm-favicon-wire";

const pngHead = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("originOfPage", () => {
    it("is the origin of a web page and nothing else", () => {
        expect(originOfPage("https://mail.google.com/mail/u/0/#inbox")).toBe("https://mail.google.com");
        expect(originOfPage("http://localhost:3000/a")).toBe("http://localhost:3000");
        for (const page of [
            "file:///etc/passwd",
            "data:text/html,x",
            "chrome-error://chromewebdata/",
            "",
            "x",
            null,
            4,
        ]) {
            expect(originOfPage(page)).toBeNull();
        }
    });

    it("refuses an origin that is not exactly an origin", () => {
        expect(validOrigin("https://notion.so")).toBe(true);
        expect(validOrigin("https://notion.so/")).toBe(false);
        expect(validOrigin("https://notion.so/path")).toBe(false);
        expect(validOrigin("https://u:p@notion.so")).toBe(false);
        expect(validOrigin("ftp://notion.so")).toBe(false);
        expect(validOrigin(`https://${"a".repeat(400)}.com`)).toBe(false);
    });
});

describe("pickIconAddress", () => {
    it("takes the first icon that is a web address or an inline image", () => {
        expect(
            pickIconAddress(["javascript:alert(1)", "ftp://x/i.png", "https://a.test/i.png", "https://b.test/j.png"])
        ).toBe("https://a.test/i.png");
        expect(pickIconAddress(["data:image/png;base64,AAAA"])).toBe("data:image/png;base64,AAAA");
    });

    it("refuses what cannot be an icon", () => {
        expect(pickIconAddress(null)).toBeNull();
        expect(pickIconAddress([])).toBeNull();
        expect(pickIconAddress([4, {}, "data:text/html;base64,AAAA", "file:///x.png"])).toBeNull();
        expect(pickIconAddress(["https://a.test/" + "x".repeat(3000)])).toBeNull();
    });
});

describe("inline icons", () => {
    it("decodes a base64 image and tells its declared type", () => {
        const data = Buffer.from(pngHead);
        const address = `data:image/png;base64,${data.toString("base64")}`;
        expect(isInlineIcon(address)).toBe(true);
        expect(isInlineIcon("https://a.test/i.png")).toBe(false);
        const decoded = decodeInlineIcon(address);
        expect(decoded.declared).toBe("image/png");
        expect(decoded.data.equals(data)).toBe(true);
    });

    it("refuses an inline image over the cap or empty", () => {
        const big = Buffer.alloc(FaviconMaxBytes + 1, 1).toString("base64");
        expect(decodeInlineIcon(`data:image/png;base64,${big}`)).toBeNull();
        expect(decodeInlineIcon("data:image/png;base64,")).toBeNull();
        expect(decodeInlineIcon("https://a.test/i.png")).toBeNull();
    });
});

describe("sniffIcon", () => {
    it("knows the formats an image tag draws, by their bytes", () => {
        expect(sniffIcon(Buffer.from(pngHead))).toBe("image/png");
        expect(sniffIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("image/jpeg");
        expect(sniffIcon(Buffer.from("GIF89a....", "latin1"))).toBe("image/gif");
        expect(sniffIcon(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe(
            "image/webp"
        );
        expect(sniffIcon(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe("image/x-icon");
        expect(sniffIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
        expect(sniffIcon(Buffer.from('<?xml version="1.0"?>\n<svg></svg>'))).toBe("image/svg+xml");
    });

    it("refuses what only calls itself an image: a page, a script, text, an empty ICO", () => {
        expect(sniffIcon(Buffer.from("<html><body>x</body></html>"))).toBeNull();
        expect(sniffIcon(Buffer.from("<script>alert(1)</script>"))).toBeNull();
        expect(sniffIcon(Buffer.from("just some text"))).toBeNull();
        expect(sniffIcon(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeNull();
        expect(sniffIcon(Buffer.alloc(0))).toBeNull();
        expect(sniffIcon(null)).toBeNull();
    });
});

describe("what the renderer asks and is told", () => {
    it("reads at most a hundred origins, and only valid ones", () => {
        const many = Array.from({ length: 150 }, (_, i) => `https://s${i}.test`);
        expect(parseFaviconOrigins(many)).toHaveLength(FaviconMaxRead);
        expect(parseFaviconOrigins(["https://a.test", "file:///x", "https://b.test/p", 4])).toEqual(["https://a.test"]);
        expect(parseFaviconOrigins("https://a.test")).toEqual([]);
    });

    it("takes a measure only for a valid origin and a boolean", () => {
        expect(parseMeasured("https://a.test", true)).toEqual({ origin: "https://a.test", dark: true });
        expect(parseMeasured("https://a.test", "yes")).toBeNull();
        expect(parseMeasured("nope", false)).toBeNull();
    });

    it("answers a data address and the dark measure when there is one", () => {
        const data = Buffer.from(pngHead);
        const answer = faviconAnswer({
            "https://a.test": { data, mime: "image/png" },
            "https://b.test": { data, mime: "image/png", dark: false },
        });
        expect(answer["https://a.test"]).toEqual({ url: iconDataUrl({ data, mime: "image/png" }) });
        expect(answer["https://b.test"].dark).toBe(false);
        expect(answer["https://a.test"].url.startsWith("data:image/png;base64,")).toBe(true);
    });
});
