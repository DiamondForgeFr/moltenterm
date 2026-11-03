// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the carpet's thumbnail channels accept and answer (#1814): the renderer is trusted as the application, but the
// store is still handed nothing it has not checked. Kept apart from Electron so the checks are tested alone.

import { ThumbMaxFileBytes, validThumbKey, validThumbTag, type StoredThumb } from "./moltenterm-carpet-thumb-store";

export const CarpetThumbPutChannel = "moltenterm-carpet-thumb-put";
export const CarpetThumbReadChannel = "moltenterm-carpet-thumb-read";
export const CarpetThumbRemoveChannel = "moltenterm-carpet-thumb-remove";

export const ThumbMaxItems = 200;
const JpegPrefix = "data:image/jpeg;base64,";

// must match CarpetThumbPutRequest in frontend/moltenterm-shell/view360/carpet-thumbs.ts
export type CarpetThumbPutRequest = {
    key: string;
    tag: string;
    // The JPEG data URL the capture answered.
    url: string;
    width: number;
    height: number;
    at: number;
};

export type CarpetThumbPut = { key: string; tag: string; data: Buffer; width: number; height: number; at: number };

export function parseThumbPut(req: unknown): CarpetThumbPut {
    const r = req as Partial<CarpetThumbPutRequest>;
    if (r == null || !validThumbKey(r.key) || !validThumbTag(r.tag) || typeof r.url !== "string") {
        return null;
    }
    if (
        !r.url.startsWith(JpegPrefix) ||
        r.url.length > Math.ceil((ThumbMaxFileBytes * 4) / 3) + JpegPrefix.length + 4
    ) {
        return null;
    }
    const data = Buffer.from(r.url.slice(JpegPrefix.length), "base64");
    if (data.length === 0 || data.length > ThumbMaxFileBytes) {
        return null;
    }
    return { key: r.key, tag: r.tag, data, width: Number(r.width), height: Number(r.height), at: Number(r.at) };
}

export function parseThumbReadItems(items: unknown): { key: string; tag: string }[] {
    if (!Array.isArray(items)) {
        return [];
    }
    return items
        .slice(0, ThumbMaxItems)
        .filter((i) => validThumbKey(i?.key) && validThumbTag(i?.tag))
        .map((i) => ({ key: i.key as string, tag: i.tag as string }));
}

export function parseThumbRemoveKeys(keys: unknown): string[] {
    if (!Array.isArray(keys)) {
        return [];
    }
    return keys.slice(0, ThumbMaxItems).filter(validThumbKey);
}

// must match StoredCarpetThumb in frontend/moltenterm-shell/view360/carpet-thumbs.ts
export type StoredCarpetThumb = { url: string; width: number; height: number; at: number };

export function thumbAnswer(found: Record<string, StoredThumb>): Record<string, StoredCarpetThumb> {
    const rtn: Record<string, StoredCarpetThumb> = {};
    for (const [key, thumb] of Object.entries(found)) {
        rtn[key] = {
            url: JpegPrefix + thumb.data.toString("base64"),
            width: thumb.width,
            height: thumb.height,
            at: thumb.at,
        };
    }
    return rtn;
}
