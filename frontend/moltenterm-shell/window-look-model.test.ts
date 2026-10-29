// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    clampOpacity,
    effectiveLook,
    globalLook,
    isTranslucent,
    lookForWorkspace,
    lookScope,
    lookTexture,
    lookWrites,
    MinOpacity,
    MinOpacityBlur,
    OpaqueLook,
    parseLook,
    peekAlpha,
    PeekBlurPx,
    PeekMinAlpha,
    ProjectLooksMetaKey,
    readProjectLook,
    resolveLook,
    textureTone,
    WindowLookMetaKey,
    withTexture,
} from "./window-look-model";

const Supported = { translucent: true, blur: true };

describe("the readable minimum (#1281, TC-SHELL-209)", () => {
    // The sidebar's text (--mt-text-main) over the frame's tint (orange accent, the warmest) laid over a white desktop.
    function contrastOverWhite(alpha: number): number {
        const tint = [0.18 * 255 + 0.82 * 20, 0.18 * 124 + 0.82 * 17, 0.18 * 13 + 0.82 * 16];
        const lin = (c: number) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
        const bg = tint.map((c) => alpha * c + (1 - alpha) * 255);
        const text = [0.03 * 255 + 0.97 * 247, 0.03 * 124 + 0.97 * 247, 0.03 * 13 + 0.97 * 247];
        return (lum(text) + 0.05) / (lum(bg) + 0.05);
    }

    it("keeps the sidebar's text at 4.5:1 over a white desktop without blur", () => {
        expect(contrastOverWhite(MinOpacity)).toBeGreaterThanOrEqual(4.5);
        expect(contrastOverWhite(MinOpacity - 0.1)).toBeLessThan(4.5);
    });

    it("clamps to the minimum, to 1 and to 5 % steps", () => {
        expect(clampOpacity(0.2, false)).toBe(MinOpacity);
        expect(clampOpacity(0.2, true)).toBe(MinOpacityBlur);
        expect(clampOpacity(1.4, false)).toBe(1);
        expect(clampOpacity(0.83, false)).toBe(0.85);
        expect(clampOpacity(NaN, false)).toBe(1);
    });

    it("reads only well-formed stored values", () => {
        expect(parseLook({ opacity: 0.8, blur: true })).toEqual({ opacity: 0.8, blur: true });
        expect(parseLook({ opacity: 0.1 })).toEqual({ opacity: MinOpacity, blur: false });
        expect(parseLook({ blur: true })).toBeNull();
        expect(parseLook("0.8")).toBeNull();
        expect(parseLook(null)).toBeNull();
    });
});

describe("precedence: workspace over project over global (#1281, TC-SHELL-210)", () => {
    const ws = { opacity: 0.75, blur: false };
    const project = { opacity: 0.9, blur: true };
    const global = { opacity: 0.8, blur: false };

    it("takes the workspace's own look first", () => {
        expect(resolveLook(ws, project, global)).toEqual({ look: ws, source: "workspace" });
    });

    it("then its project's", () => {
        expect(resolveLook(null, project, global)).toEqual({ look: project, source: "project" });
    });

    it("then Wave's global settings, opaque unless window:transparent or window:blur is on", () => {
        expect(resolveLook(null, null, global)).toEqual({ look: global, source: "global" });
        expect(globalLook({})).toEqual(OpaqueLook);
        expect(globalLook({ "window:opacity": 0.5 })).toEqual(OpaqueLook);
        expect(globalLook({ "window:transparent": true })).toEqual({ opacity: 0.8, blur: false });
        expect(globalLook({ "window:blur": true, "window:opacity": 0.6 })).toEqual({ opacity: 0.6, blur: true });
    });

    it("reads the project's look by its folder", () => {
        const clientMeta = { [ProjectLooksMetaKey]: { "/code/a": { opacity: 0.85 }, "": { opacity: 0.8 } } };
        expect(readProjectLook(clientMeta, "/code/a")).toEqual({ opacity: 0.85, blur: false });
        expect(readProjectLook(clientMeta, "/code/b")).toBeNull();
        expect(readProjectLook(clientMeta, "")).toBeNull();
    });

    it("saves on the workspace by default, on the project once the workspace follows it", () => {
        expect(lookScope(null, null, true)).toBe("workspace");
        expect(lookScope(ws, project, true)).toBe("workspace");
        expect(lookScope(null, project, true)).toBe("project");
        expect(lookScope(null, project, false)).toBe("workspace");
    });

    it("writes a project look for every workspace on it and lets go of the workspace's own", () => {
        const clientMeta = { [ProjectLooksMetaKey]: { "/code/b": { opacity: 0.9, blur: false } } };
        expect(lookWrites("project", ws, "/code/a", clientMeta)).toEqual({
            workspace: { [WindowLookMetaKey]: null },
            client: { [ProjectLooksMetaKey]: { "/code/b": { opacity: 0.9, blur: false }, "/code/a": ws } },
        });
        expect(lookWrites("workspace", ws, "/code/a", clientMeta)).toEqual({ workspace: { [WindowLookMetaKey]: ws } });
        expect(lookWrites("project", ws, "", clientMeta)).toEqual({ workspace: { [WindowLookMetaKey]: ws } });
    });
});

describe("switching workspaces switches the look (#1281, TC-SHELL-211)", () => {
    const clientMeta = { [ProjectLooksMetaKey]: { "/code/shared": { opacity: 0.8, blur: true } } };
    const settings = {};

    it("gives each workspace its own, its project's or the global look", () => {
        const a = { meta: { [WindowLookMetaKey]: { opacity: 0.7, blur: false } } };
        const b = { meta: {} };
        const c = { meta: {} };
        expect(lookForWorkspace(a, "/code/shared", clientMeta, settings).look).toEqual({ opacity: 0.7, blur: false });
        expect(lookForWorkspace(b, "/code/shared", clientMeta, settings)).toEqual({
            look: { opacity: 0.8, blur: true },
            source: "project",
        });
        expect(lookForWorkspace(c, "/code/other", clientMeta, settings)).toEqual({
            look: OpaqueLook,
            source: "global",
        });
    });

    it("draws translucency only when the look asks for it", () => {
        expect(isTranslucent(OpaqueLook)).toBe(false);
        expect(isTranslucent({ opacity: 0.9, blur: false })).toBe(true);
        expect(isTranslucent({ opacity: 1, blur: true })).toBe(true);
    });
});

describe("reduced transparency and platforms (#1281, TC-SHELL-212)", () => {
    const look = { opacity: 0.75, blur: true };

    it("stays opaque when the system asks for reduced transparency, and says why", () => {
        expect(effectiveLook(look, true, Supported)).toEqual({ look: OpaqueLook, reason: "reducedTransparency" });
    });

    it("stays opaque where the window cannot be see-through, and says why", () => {
        expect(effectiveLook(look, false, { translucent: false, blur: false })).toEqual({
            look: OpaqueLook,
            reason: "unsupported",
        });
    });

    it("drops only the blur where the window cannot blur, keeping the no-blur minimum", () => {
        expect(effectiveLook({ opacity: 0.5, blur: true }, false, { translucent: true, blur: false })).toEqual({
            look: { opacity: MinOpacity, blur: false },
            reason: null,
        });
    });

    it("needs no reason for an opaque look", () => {
        expect(effectiveLook(OpaqueLook, true, { translucent: false, blur: false })).toEqual({
            look: OpaqueLook,
            reason: null,
        });
        expect(effectiveLook(look, false, Supported)).toEqual({ look, reason: null });
    });
});

describe("the texture: stored values and precedence (#1294, TC-SHELL-222, TC-SHELL-223)", () => {
    it("stores the texture beside the opacity, only when there is one", () => {
        expect(parseLook({ opacity: 1, blur: false, texture: "grain", intensity: 0.7 })).toEqual({
            opacity: 1,
            blur: false,
            texture: "grain",
            intensity: 0.7,
        });
        expect(parseLook({ opacity: 1, texture: "dots" })).toEqual({
            opacity: 1,
            blur: false,
            texture: "dots",
            intensity: 0.5,
        });
        expect(parseLook({ opacity: 1, texture: "grain", intensity: 3 })?.intensity).toBe(1);
        expect(parseLook({ opacity: 0.8, texture: "none", intensity: 0.4 })).toStrictEqual({
            opacity: 0.8,
            blur: false,
        });
        expect(parseLook({ opacity: 0.8, texture: "plaid" })).toStrictEqual({ opacity: 0.8, blur: false });
        expect(lookTexture({ texture: "paper", intensity: "x" })).toEqual({ texture: "paper", intensity: 0.5 });
    });

    it("changes the texture without touching the opacity, and lets none go", () => {
        const look = { opacity: 0.8, blur: true };
        expect(withTexture(look, "lines")).toEqual({ opacity: 0.8, blur: true, texture: "lines", intensity: 0.5 });
        expect(withTexture({ ...look, texture: "grain", intensity: 0.9 }, "none")).toStrictEqual(look);
        expect(withTexture({ ...look, texture: "grain", intensity: 0.9 }, "paper").intensity).toBe(0.9);
        expect(withTexture(null, "grain", 0.3)).toEqual({ opacity: 1, blur: false, texture: "grain", intensity: 0.3 });
    });

    it("follows the opacity's precedence: workspace, then project, then none", () => {
        const clientMeta = {
            [ProjectLooksMetaKey]: { "/code/shared": { opacity: 1, blur: false, texture: "paper", intensity: 0.5 } },
        };
        const own = { meta: { [WindowLookMetaKey]: { opacity: 0.9, blur: false, texture: "grain", intensity: 0.4 } } };
        const follows = { meta: {} };
        expect(lookForWorkspace(own, "/code/shared", clientMeta, {}).look.texture).toBe("grain");
        expect(lookForWorkspace(follows, "/code/shared", clientMeta, {})).toEqual({
            look: { opacity: 1, blur: false, texture: "paper", intensity: 0.5 },
            source: "project",
        });
        const global = lookForWorkspace(follows, "/code/other", clientMeta, { "window:transparent": true });
        expect(global.source).toBe("global");
        expect(global.look.texture).toBeUndefined();
    });

    it("saves the texture where the opacity goes", () => {
        const look = { opacity: 1, blur: false, texture: "dots" as const, intensity: 0.5 };
        expect(lookWrites("project", look, "/code/a", {})).toEqual({
            workspace: { [WindowLookMetaKey]: null },
            client: { [ProjectLooksMetaKey]: { "/code/a": look } },
        });
        expect(lookWrites("workspace", look, "/code/a", {})).toEqual({ workspace: { [WindowLookMetaKey]: look } });
    });
});

describe("the texture under reduced transparency (#1294, TC-SHELL-225)", () => {
    const look = { opacity: 0.75, blur: true, texture: "grain" as const, intensity: 0.6 };
    const textured = { opacity: 1, blur: false, texture: "grain", intensity: 0.6 };

    it("stays while the window stays opaque", () => {
        expect(effectiveLook(look, true, Supported)).toEqual({ look: textured, reason: "reducedTransparency" });
        expect(effectiveLook(look, false, { translucent: false, blur: false })).toEqual({
            look: textured,
            reason: "unsupported",
        });
        expect(effectiveLook(textured as any, false, Supported)).toEqual({ look: textured, reason: null });
        expect(effectiveLook(look, false, Supported).look).toEqual(look);
    });

    it("takes light ink on an opaque frame, dark ink on a see-through one", () => {
        expect(textureTone(effectiveLook(look, true, Supported).look)).toBe("light");
        expect(textureTone(effectiveLook(look, false, Supported).look)).toBe("dark");
    });
});

describe("the floating sidebar over the panels (#1298, TC-SHELL-227)", () => {
    const css = fs.readFileSync(path.join(__dirname, "window-look.css"), "utf8");

    function rule(selector: string): string {
        const at = css.indexOf(`${selector} {`);
        return at < 0 ? null : css.slice(at, css.indexOf("}", at));
    }

    it("blurs what is under it and keeps its tint at the peek alpha when the window is see-through", () => {
        const peek = rule("html.mt-translucent .mt-sb.is-hidden");
        expect(peek).toMatch(/backdrop-filter:\s*blur\(var\(--mt-peek-blur/);
        expect(peek).toContain("var(--mt-peek-alpha");
        expect(peek).not.toContain("--mt-window-alpha");
    });

    it("never lets the tint under the readable minimum, and stays opaque on an opaque window", () => {
        expect(peekAlpha({ opacity: 0.5, blur: true })).toBe(PeekMinAlpha);
        expect(peekAlpha({ opacity: 0.7, blur: false })).toBe(PeekMinAlpha);
        expect(peekAlpha({ opacity: 0.95, blur: false })).toBe(0.95);
        expect(peekAlpha({ opacity: 1, blur: true })).toBe(1);
        expect(peekAlpha(OpaqueLook)).toBe(1);
        expect(peekAlpha(effectiveLook({ opacity: 0.6, blur: true }, true, Supported).look)).toBe(1);
        expect(PeekBlurPx).toBeGreaterThanOrEqual(12);
    });

    // The worst spot: a white page under the panel (the blur cannot darken a flat white), a hovered row's highlight on
    // top, the lightest workspace colour.
    it("keeps the sidebar's text at 4.5:1 over a white page under it", () => {
        const lin = (c: number) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
        const over = (top: number[], a: number, under: number[]) => under.map((c, i) => a * top[i] + (1 - a) * c);
        const contrastAt = (alpha: number, accent: number[]) => {
            const tint = over([0, 0, 0], 0.12, over(accent, 0.18, [20, 17, 16]));
            const spot = over([255, 255, 255], 0.1, over(tint, alpha, [255, 255, 255]));
            const text = over(accent, 0.03, [247, 247, 247]);
            return (lum(text) + 0.05) / (lum(spot) + 0.05);
        };
        for (const accent of [
            [255, 255, 255],
            [255, 124, 13],
            [0, 255, 219],
            [214, 221, 230],
        ]) {
            expect(contrastAt(PeekMinAlpha, accent)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastAt(MinOpacity, [255, 255, 255])).toBeLessThan(4.5);
    });
});
