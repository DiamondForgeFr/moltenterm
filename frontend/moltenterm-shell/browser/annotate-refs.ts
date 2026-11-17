// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The reference images of a zone's comment (FR-BRW-017 AC21, #2327): the developer pastes an image, or drops an image
// file, on the open comment field, to show the agent what they have in mind. Like the capture, an image is checked
// before it is decoded (its type, its size and the size its header declares), decoded, scaled down and written again: as
// a PNG, or as a JPEG when the PNG is too large, to a size wavesrv takes (annotate.go checks it again). The window reads
// only what the developer's paste or drop gave it, as File objects: no path is typed, read or listed, no folder is
// browsed.

import { type AnnotateState, attachRef, refRoom } from "./annotate-model";

export const RefTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// A source image over this is refused before anything decodes it.
export const MaxRefSourceBytes = 8 * 1024 * 1024;
// An image that declares more pixels than this is refused before it is decoded: a few bytes can declare a size whose
// decoding takes all the memory of the window.
export const MaxRefPixels = 40_000_000;
// The first bytes of the file, where every format says its size.
export const RefHeaderBytes = 64 * 1024;
// The written image as a data URL, at most: about 500 KB of bytes, which wavesrv takes; eight of them and the capture
// stay under the websocket's 10 MB.
export const MaxRefChars = 680_000;
// The longer side tried, largest first, and the JPEG qualities tried for each.
export const RefSides = [1280, 960, 720, 540];
export const RefJpegQualities = [0.85, 0.7];

// type: not a png, jpeg, webp or gif; size: over the limit before decoding; decode: the image is empty or could not be
// read; large: it declares too many pixels, or is still too large once scaled down as far as tried.
export type RefRefusal = "type" | "size" | "decode" | "large";

export class RefError extends Error {
    reason: RefRefusal;
    constructor(reason: RefRefusal) {
        super(`the image cannot be attached (${reason})`);
        this.reason = reason;
    }
}

// checkRefSource: what is checked before the image is decoded. An empty file holds no image to read.
export function checkRefSource(type: string, size: number): RefRefusal {
    if (!RefTypes.includes((type ?? "").toLowerCase())) {
        return "type";
    }
    if (!(size > 0)) {
        return "decode";
    }
    return size > MaxRefSourceBytes ? "size" : null;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));

// readImageSize: the size an image declares in its header (the first RefHeaderBytes of the file), by the format its
// bytes say, not the one its type claims: a PNG's IHDR, a GIF's screen, a JPEG's first frame header, a WebP's VP8, VP8L
// or VP8X chunk. null when no size is read. Nothing is decoded.
export function readImageSize(head: Uint8Array): { w: number; h: number } {
    const b = head;
    if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG") && ascii(b, 12, "IHDR")) {
        return { w: be32(b, 16), h: be32(b, 20) };
    }
    if (b.length >= 10 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) {
        return { w: le16(b, 6), h: le16(b, 8) };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = b[i + 1];
            if (marker === 0xff) {
                i++;
                continue;
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { w: be16(b, i + 7), h: be16(b, i + 5) };
            }
            i += 2 + be16(b, i + 2);
        }
        return null;
    }
    if (b.length >= 30 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
        if (ascii(b, 12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
            return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
        }
        if (ascii(b, 12, "VP8L") && b[20] === 0x2f) {
            return {
                w: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
                h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
            };
        }
        if (ascii(b, 12, "VP8X")) {
            return {
                w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
                h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
            };
        }
    }
    return null;
}

type TransferItem = { kind: string; type: string; getAsFile(): File };
type Transfer = { files?: ArrayLike<File>; items?: ArrayLike<TransferItem>; types?: ArrayLike<string> };

// carriesFiles: a drag that holds files, which the comment field takes a drop of; a dragged text or address, or the move
// of a text inside the field, is not one and stays the browser's own.
export function carriesFiles(transfer: Transfer): boolean {
    return Array.from(transfer?.types ?? []).includes("Files");
}

// imageBlobs: the images a paste or a drop holds, as the File objects the event itself gives (its files, else its file
// items): nothing else is read. A file that is not an image is not one of them.
export function imageBlobs(transfer: Transfer): File[] {
    const out: File[] = [];
    for (const file of Array.from(transfer?.files ?? [])) {
        if (file != null && (file.type ?? "").startsWith("image/")) {
            out.push(file);
        }
    }
    if (out.length > 0) {
        return out;
    }
    for (const item of Array.from(transfer?.items ?? [])) {
        if (item?.kind === "file" && (item.type ?? "").startsWith("image/")) {
            const file = item.getAsFile();
            if (file != null) {
                out.push(file);
            }
        }
    }
    return out;
}

// dropHandling: what the field does with a drop. It takes the drop (claim) only when it holds files, which would
// otherwise be opened in place of the app; it attaches the images among them and counts the files that are none.
export function dropHandling(transfer: Transfer): { claim: boolean; images: File[]; others: number } {
    if (!carriesFiles(transfer)) {
        return { claim: false, images: [], others: 0 };
    }
    const images = imageBlobs(transfer);
    const files = Array.from(transfer?.files ?? []).length;
    return { claim: true, images, others: Math.max(0, files - images.length) };
}

// pasteHandling: a paste is the field's to take only when it holds an image; a pasted text is the text field's own.
export function pasteHandling(transfer: Transfer): { claim: boolean; images: File[] } {
    const images = imageBlobs(transfer);
    return { claim: images.length > 0, images };
}

type FieldEvent = { preventDefault(): void };
type OnAttach = (files: File[], others: number) => void;

// The comment field's handlers of a drag over, a drop and a paste, apart from React so that a test runs them: each calls
// preventDefault only for what the field takes, and leaves every other event to the browser.
export function fieldDragOver(e: FieldEvent & { dataTransfer?: Transfer }): void {
    if (carriesFiles(e.dataTransfer)) {
        e.preventDefault();
    }
}

export function fieldDrop(e: FieldEvent & { dataTransfer?: Transfer }, onAttach: OnAttach): void {
    const drop = dropHandling(e.dataTransfer);
    if (!drop.claim) {
        return;
    }
    e.preventDefault();
    onAttach(drop.images, drop.others);
}

export function fieldPaste(e: FieldEvent & { clipboardData?: Transfer }, onAttach: OnAttach): void {
    const paste = pasteHandling(e.clipboardData);
    if (!paste.claim) {
        return;
    }
    e.preventDefault();
    onAttach(paste.images, 0);
}

// fitRefSize: the image's size with its longer side at most maxSide, never larger.
export function fitRefSize(width: number, height: number, maxSide: number): { w: number; h: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// prepareReference: the pasted or dropped image as the data URL that is attached: checked (its type, its size, the size
// its header declares), decoded (a gif gives its first frame), laid on white, scaled down and written again. Throws a
// RefError saying why not.
export async function prepareReference(blob: Blob): Promise<string> {
    const refusal = checkRefSource(blob.type, blob.size);
    if (refusal != null) {
        throw new RefError(refusal);
    }
    let declared: { w: number; h: number };
    try {
        declared = readImageSize(new Uint8Array(await blob.slice(0, RefHeaderBytes).arrayBuffer()));
    } catch {
        throw new RefError("decode");
    }
    if (declared == null || !(declared.w > 0) || !(declared.h > 0)) {
        throw new RefError("decode");
    }
    if (declared.w * declared.h > MaxRefPixels) {
        throw new RefError("large");
    }
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        throw new RefError("decode");
    }
    try {
        for (const side of RefSides) {
            const size = fitRefSize(bitmap.width, bitmap.height, side);
            const canvas = document.createElement("canvas");
            canvas.width = size.w;
            canvas.height = size.h;
            const ctx = canvas.getContext("2d");
            if (ctx == null) {
                throw new RefError("decode");
            }
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, size.w, size.h);
            ctx.drawImage(bitmap, 0, 0, size.w, size.h);
            const png = canvas.toDataURL("image/png");
            if (png.length <= MaxRefChars) {
                return png;
            }
            for (const quality of RefJpegQualities) {
                const jpeg = canvas.toDataURL("image/jpeg", quality);
                if (jpeg.length <= MaxRefChars) {
                    return jpeg;
                }
            }
        }
    } finally {
        bitmap.close?.();
    }
    throw new RefError("large");
}

// Why an image was left out: the reasons of prepareReference, the limits of a zone and a report, a file that is no image.
export type AttachNote = RefRefusal | "zone" | "report" | "notimage";

export type AttachDeps = {
    getState: () => AnnotateState;
    setState: (state: AnnotateState) => void;
    prepare?: (blob: Blob) => Promise<string>;
};

// attachReferences: the images of a paste or a drop, attached to a zone in turn. Whether the zone and the report have
// room is asked before an image is prepared, so that none is decoded for nothing; one that cannot be prepared is left
// out and the next is tried. It answers the first reason something was left out, null when everything was attached.
export async function attachReferences(
    zoneId: number,
    files: Blob[],
    others: number,
    deps: AttachDeps
): Promise<AttachNote> {
    const prepare = deps.prepare ?? prepareReference;
    let note: AttachNote = null;
    for (const file of files) {
        const full = refRoom(deps.getState(), zoneId);
        if (full) {
            return note ?? full;
        }
        let dataUrl: string;
        try {
            dataUrl = await prepare(file);
        } catch (e) {
            note = note ?? (e instanceof RefError ? e.reason : "decode");
            continue;
        }
        const attached = attachRef(deps.getState(), zoneId, dataUrl);
        if (attached.refused) {
            return note ?? attached.refused;
        }
        deps.setState(attached.state);
    }
    return note ?? (others > 0 ? "notimage" : null);
}
