// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Chromium of Electron 45.2.3 ignores a canvas `font` value that starts with a space and keeps the previous one
// (#2065). xterm's WebGL renderer draws its glyph atlas with `${fontStyle} ${fontWeight} ${size}px ${family}`, whose
// style is empty for upright text: every glyph was drawn in the default "10px sans-serif" into cells measured for the
// terminal font, tiny and far apart. Trimming the value at the setter fixes xterm and any other library that builds the
// shorthand the same way, whatever version either ships.

type FontContext = { prototype: object };

function trimFontSetter(ctor: FontContext | undefined): boolean {
    if (ctor == null) return false;
    const desc = Object.getOwnPropertyDescriptor(ctor.prototype, "font");
    if (desc?.set == null || desc.get == null) return false;
    if ((desc.set as { moltenTrimmed?: boolean }).moltenTrimmed) return true;
    const set = function (this: unknown, value: unknown) {
        desc.set.call(this, typeof value === "string" ? value.trim() : value);
    };
    (set as { moltenTrimmed?: boolean }).moltenTrimmed = true;
    Object.defineProperty(ctor.prototype, "font", { ...desc, set });
    return true;
}

// Installs the trim on the 2D contexts of the page (on-screen and offscreen). Returns how many it patched.
export function installCanvasFontTrim(scope: Record<string, unknown> = globalThis as Record<string, unknown>): number {
    let patched = 0;
    for (const name of ["CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D"]) {
        if (trimFontSetter(scope[name] as FontContext | undefined)) patched++;
    }
    return patched;
}
