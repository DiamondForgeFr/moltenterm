// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a site's icon is too dark to read on the dark sidebar (#1962, DS-SHELL-126): measured once, by the window that
// first draws it, and kept with the icon. A dark icon is drawn on a light plate (favicon-mark.tsx); every other icon is
// drawn as it is. The rule is pure so it is tested without a canvas.

// The icon is measured on a small copy of itself.
export const MeasureSize = 16;
// An icon counts as dark when the pixels that show (not transparent) are, on average, darker than this share of white,
// and they cover enough of the icon for the rest of it not to carry it.
export const DarkLuminance = 0.28;
export const MinCoverage = 0.2;
const MinAlpha = 40;

// rgba: the pixels of the icon, four bytes each, as a canvas gives them.
export function isDarkPixels(rgba: ArrayLike<number>): boolean {
    let shown = 0;
    let sum = 0;
    const pixels = Math.floor(rgba.length / 4);
    for (let i = 0; i < pixels; i++) {
        const alpha = rgba[i * 4 + 3];
        if (alpha < MinAlpha) {
            continue;
        }
        shown++;
        // The weights of the relative luminance, on the sRGB values as they are: a light enough measure for an icon.
        sum += (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
    }
    if (pixels === 0 || shown / pixels < MinCoverage) {
        return false;
    }
    return sum / shown < DarkLuminance;
}

// null when the image cannot be decoded here: the caller draws the generic web icon for it.
export function measureDark(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = MeasureSize;
                canvas.height = MeasureSize;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(image, 0, 0, MeasureSize, MeasureSize);
                resolve(isDarkPixels(ctx.getImageData(0, 0, MeasureSize, MeasureSize).data));
            } catch {
                resolve(null);
            }
        };
        image.onerror = () => resolve(null);
        image.src = url;
    });
}
