// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    clampOpacity,
    effectiveLook,
    globalLook,
    isTranslucent,
    lookForWorkspace,
    lookScope,
    lookWrites,
    MinOpacity,
    MinOpacityBlur,
    OpaqueLook,
    parseLook,
    ProjectLooksMetaKey,
    readProjectLook,
    resolveLook,
    WindowLookMetaKey,
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
