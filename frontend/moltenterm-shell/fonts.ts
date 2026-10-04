// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The interface typeface (FR-SHELL-014): IBM Plex Sans, bundled under public/fonts with its OFL licence
// (ibm-plex-sans-ofl.txt), from the official @ibm/plex-sans-variable package. One variable file per subset covers
// weights 100-700; only latin and latin-ext ship, other scripts fall back to the system face. The app loads no
// remote font.

export const PlexSansFamily = "IBM Plex Sans";

const PlexSansSubsets: { file: string; unicodeRange: string }[] = [
    {
        file: "ibm-plex-sans-var-latin1.woff2",
        unicodeRange:
            "U+0000, U+000D, U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, " +
            "U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+20AC, U+2122, U+2212, " +
            "U+FB01-FB02",
    },
    {
        file: "ibm-plex-sans-var-latin2.woff2",
        unicodeRange:
            "U+0100-0101, U+0104-0130, U+0132-0151, U+0154-017F, U+018F, U+0192, U+01A0-01A1, U+01AF-01B0, " +
            "U+01FA-01FF, U+0218-021B, U+0237, U+0259, U+1E80-1E85, U+1E9E, U+20A1, U+20A4, U+20A6, U+20A8-20AA, " +
            "U+20AD-20AE, U+20B1-20B2, U+20B4-20B5, U+20B8-20BA, U+20BD, U+20BF",
    },
];

// Plex's own line box (ascent 1.025 + descent 0.275 em) is taller than Inter's (0.969 + 0.241): every element left at
// `line-height: normal` (Wave's --base-font, the palette rows) would grow by about 1.5px. Inter's metrics keep the
// layout identical and centre Plex's capitals slightly better.
const PlexSansMetrics = { ascentOverride: "96.9%", descentOverride: "24.1%", lineGapOverride: "0%" };

let isPlexSansLoaded = false;

export function loadPlexSansFont() {
    if (isPlexSansLoaded) {
        return;
    }
    isPlexSansLoaded = true;
    for (const subset of PlexSansSubsets) {
        const face = new FontFace(PlexSansFamily, `url('fonts/${subset.file}')`, {
            style: "normal",
            weight: "100 700",
            unicodeRange: subset.unicodeRange,
            ...PlexSansMetrics,
        } as FontFaceDescriptors);
        (document.fonts as any).add(face);
        face.load();
    }
}
