// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// xterm's WebGL addon hands one glyph atlas to every terminal of the window with the same font, size, theme and pixel
// ratio (`acquireTextureAtlas`). Clearing it (`clearTextureAtlas`, #290's full repaint) wipes every page for all of
// them but resets the render model of the calling terminal only: the others keep, for each cell that has not changed,
// the atlas coordinates of the glyph they drew before, and their next frame samples the refilled atlas there (garbled
// glyphs until a full refresh, #801). So an atlas clear is never local: it goes through here, and every WebGL
// terminal of the window clears its model and redraws in full in the same pass, before any of them draws a frame.
// Calling `clearTextureAtlas` on an atlas that is already empty leaves the atlas alone and only does that reset.

export type AtlasClearer = () => void;

const clearers = new Set<AtlasClearer>();

export function registerAtlasClearer(clearer: AtlasClearer): () => void {
    clearers.add(clearer);
    return () => {
        clearers.delete(clearer);
    };
}

export function clearSharedTextureAtlas(): void {
    for (const clearer of Array.from(clearers)) {
        try {
            clearer();
        } catch (e) {
            console.log("[shared-atlas] clear failed", e);
        }
    }
}

export function registeredAtlasClearerCount(): number {
    return clearers.size;
}
