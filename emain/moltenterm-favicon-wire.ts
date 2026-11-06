// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the favicon channels accept and answer (#1962): an icon is a page's own declaration, read through the page's
// session, so everything about it is checked before it is kept: the address is a web address, the image is one of the
// formats an <img> draws and weighs at most 64 KB, and what the renderer asks for is a web origin. The icon is only ever
// drawn as an image, never as markup. Kept apart from Electron so the checks are tested alone.

import { FaviconMaxBytes, type StoredFavicon } from "./moltenterm-favicon-store";

export const FaviconReadChannel = "moltenterm-favicon-read";
export const FaviconMeasuredChannel = "moltenterm-favicon-measured";
export const FaviconCaptureChannel = "moltenterm-favicon-capture";
// Electron main to the application's windows: an icon was kept for an origin.
export const FaviconChangedChannel = "moltenterm-favicon-changed";

export const FaviconMaxRead = 100;
const MaxAddressChars = 2048;
const MaxOriginChars = 300;
const DataImagePrefix = /^data:image\/[a-z0-9.+-]+;base64,/i;

// must match FaviconReading in frontend/moltenterm-shell/favicon/favicon-store.ts
export type FaviconAnswer = { url: string; dark?: boolean };

// The origin of a page, null for anything that is not a web page (a data page, a file, an error document).
export function originOfPage(page: unknown): string {
    if (typeof page !== "string" || page.length > MaxAddressChars) {
        return null;
    }
    try {
        const url = new URL(page);
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
        return null;
    }
}

export function validOrigin(origin: unknown): origin is string {
    return typeof origin === "string" && origin.length <= MaxOriginChars && originOfPage(origin) === origin;
}

// The first icon a page declares that can be read: a web address, or a base64 image sent inline.
export function pickIconAddress(favicons: unknown): string {
    if (!Array.isArray(favicons)) {
        return null;
    }
    for (const entry of favicons) {
        if (typeof entry !== "string") {
            continue;
        }
        if (DataImagePrefix.test(entry) && entry.length <= Math.ceil((FaviconMaxBytes * 4) / 3) + 64) {
            return entry;
        }
        if (entry.length <= MaxAddressChars && originOfPage(entry) != null) {
            return entry;
        }
    }
    return null;
}

export function isInlineIcon(address: string): boolean {
    return DataImagePrefix.test(address);
}

export function decodeInlineIcon(address: string): { data: Buffer; declared: string } {
    const match = DataImagePrefix.exec(address ?? "");
    if (match == null) {
        return null;
    }
    const declared = match[0].slice("data:".length, match[0].indexOf(";"));
    const data = Buffer.from(address.slice(match[0].length), "base64");
    return data.length > 0 && data.length <= FaviconMaxBytes ? { data, declared } : null;
}

function startsWith(data: Buffer, bytes: number[], at = 0): boolean {
    return data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);
}

// The image format of the bytes, whatever the page or the server called it; null when it is not one an <img> draws
// from these. SVG is text: it counts only when the file really is an SVG document, and it is drawn as an image, where
// a script never runs.
export function sniffIcon(data: Buffer): string {
    if (data == null || data.length < 4) {
        return null;
    }
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return "image/png";
    }
    if (startsWith(data, [0xff, 0xd8, 0xff])) {
        return "image/jpeg";
    }
    if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) {
        return "image/gif";
    }
    if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
        return "image/webp";
    }
    if (startsWith(data, [0x00, 0x00, 0x01, 0x00]) && data.length >= 6 && data.readUInt16LE(4) > 0) {
        return "image/x-icon";
    }
    const head = data.subarray(0, Math.min(data.length, 1024)).toString("utf8").trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
        return "image/svg+xml";
    }
    return null;
}

export function iconDataUrl(icon: Pick<StoredFavicon, "data" | "mime">): string {
    return `data:${icon.mime};base64,${icon.data.toString("base64")}`;
}

export function parseFaviconOrigins(origins: unknown): string[] {
    if (!Array.isArray(origins)) {
        return [];
    }
    return origins.slice(0, FaviconMaxRead).filter(validOrigin);
}

export function faviconAnswer(found: Record<string, StoredFavicon>): Record<string, FaviconAnswer> {
    const answer: Record<string, FaviconAnswer> = {};
    for (const [origin, icon] of Object.entries(found)) {
        answer[origin] = icon.dark == null ? { url: iconDataUrl(icon) } : { url: iconDataUrl(icon), dark: icon.dark };
    }
    return answer;
}

export function parseMeasured(origin: unknown, dark: unknown): { origin: string; dark: boolean } {
    return validOrigin(origin) && typeof dark === "boolean" ? { origin, dark } : null;
}
