// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The reference images of a zone's comment (FR-BRW-017 AC21, #2327): the developer pastes an image, or drops an image
// file, on the open comment field, to show the agent what they have in mind. Like the capture, an image is checked
// before it is decoded (its type and its size), decoded, scaled down and written again: as a PNG, or as a JPEG when the
// PNG is too large, to a size wavesrv takes (annotate.go checks it again). The window reads only what the developer's
// paste or drop gave it, as File objects: no path is typed, read or listed, no folder is browsed.

export const RefTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// A source image over this is refused before anything decodes it.
export const MaxRefSourceBytes = 8 * 1024 * 1024;
// The written image as a data URL, at most: about 500 KB of bytes, which wavesrv takes; eight of them and the capture
// stay under the websocket's 10 MB.
export const MaxRefChars = 680_000;
// The longer side tried, largest first, and the JPEG qualities tried for each.
export const RefSides = [1280, 960, 720, 540];
export const RefJpegQualities = [0.85, 0.7];

// type: not a png, jpeg, webp or gif; size: over the limit before decoding; decode: the image could not be read;
// large: still too large once scaled down as far as tried.
export type RefRefusal = "type" | "size" | "decode" | "large";

export class RefError extends Error {
    reason: RefRefusal;
    constructor(reason: RefRefusal) {
        super(`the image cannot be attached (${reason})`);
        this.reason = reason;
    }
}

// checkRefSource: what is checked before the image is decoded.
export function checkRefSource(type: string, size: number): RefRefusal {
    if (!RefTypes.includes((type ?? "").toLowerCase())) {
        return "type";
    }
    if (!(size > 0) || size > MaxRefSourceBytes) {
        return "size";
    }
    return null;
}

type TransferItem = { kind: string; type: string; getAsFile(): File };
type Transfer = { files?: ArrayLike<File>; items?: ArrayLike<TransferItem> };

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

// fitRefSize: the image's size with its longer side at most maxSide, never larger.
export function fitRefSize(width: number, height: number, maxSide: number): { w: number; h: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// prepareReference: the pasted or dropped image as the data URL that is attached: checked, decoded (a gif gives its first
// frame), laid on white, scaled down and written again. Throws a RefError saying why not.
export async function prepareReference(blob: Blob): Promise<string> {
    const refusal = checkRefSource(blob.type, blob.size);
    if (refusal != null) {
        throw new RefError(refusal);
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
