// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { installCanvasFontTrim } from "./canvas-font";

// A 2D context as the Chromium of Electron 45.2.3 behaves (#2065): a value with a leading space is ignored.
function makeChromiumLikeContext() {
    class Ctx {
        stored = "10px sans-serif";
        get font(): string {
            return this.stored;
        }
        set font(value: string) {
            if (/^\s/.test(value)) return;
            this.stored = value;
        }
    }
    return Ctx;
}

// What xterm's WebGL atlas sets for upright text: `${fontStyle} ${fontWeight} ${size}px ${family}`, the style empty.
function xtermAtlasFont(italic: boolean, weight: string, size: number, family: string): string {
    return `${italic ? "italic" : ""} ${weight} ${size}px ${family}`;
}

describe("installCanvasFontTrim", () => {
    it("keeps the terminal font of xterm's glyph atlas instead of the default 10px sans-serif", () => {
        const Ctx = makeChromiumLikeContext();
        expect(installCanvasFontTrim({ CanvasRenderingContext2D: Ctx })).toBe(1);
        const ctx = new Ctx();
        ctx.font = xtermAtlasFont(false, "normal", 24, "Hack");
        expect(ctx.font).toBe("normal 24px Hack");
        ctx.font = xtermAtlasFont(true, "bold", 24, "Hack");
        expect(ctx.font).toBe("italic bold 24px Hack");
    });

    it("patches the offscreen context too, once, and leaves other values as they are", () => {
        const On = makeChromiumLikeContext();
        const Off = makeChromiumLikeContext();
        const scope = { CanvasRenderingContext2D: On, OffscreenCanvasRenderingContext2D: Off };
        expect(installCanvasFontTrim(scope)).toBe(2);
        expect(installCanvasFontTrim(scope)).toBe(2);
        const off = new Off();
        off.font = "  12px monospace  ";
        expect(off.font).toBe("12px monospace");
        off.font = "bold 12px Hack";
        expect(off.font).toBe("bold 12px Hack");
    });

    it("does nothing where a context has no font property", () => {
        expect(installCanvasFontTrim({})).toBe(0);
        expect(installCanvasFontTrim({ CanvasRenderingContext2D: class {} })).toBe(0);
    });
});
