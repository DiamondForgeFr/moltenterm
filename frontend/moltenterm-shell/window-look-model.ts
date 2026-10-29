// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace's look (#1281, FR-SHELL-091): how opaque the window's frame and sidebar are, and whether what is
// behind the window is blurred. Saved on the workspace by default, or on its project so every workspace on that project
// shares it; the global window:opacity / window:transparent / window:blur settings come last. Kept apart from the
// components and from Electron so the rules are tested alone.

import { clampTextureIntensity, isTextureKind, TextureKind, TextureTone } from "./window-texture";

// must match WindowLookMetaKey's readers only in the frontend; wavesrv stores the value as any other meta.
export const WindowLookMetaKey = "molten:windowlook";
// On the client object: { "<project folder>": { opacity, blur } }.
export const ProjectLooksMetaKey = "molten:projectlooks";

// The frame and the sidebar carry text: below these the sidebar's text over a white desktop drops under 4.5:1
// (window-look-model.test.ts computes it). The blur's dark material keeps text readable lower.
export const MinOpacity = 0.7;
export const MinOpacityBlur = 0.5;
export const OpacityStep = 0.05;
// Wave's default when window:transparent is on without window:opacity (frontend/app/app.tsx).
export const GlobalDefaultOpacity = 0.8;

// texture and intensity (#1294) are absent for no texture; intensity only moves the grain.
export type WindowLook = { opacity: number; blur: boolean; texture?: TextureKind; intensity?: number };
export type LookSource = "workspace" | "project" | "global";
export type LookScope = "workspace" | "project";

export const OpaqueLook: WindowLook = { opacity: 1, blur: false };

// The texture part of a look, well formed: nothing for none, else the kind and its intensity on the slider's steps.
export function lookTexture(look: { texture?: any; intensity?: any }): { texture?: TextureKind; intensity?: number } {
    const kind = look?.texture;
    if (!isTextureKind(kind) || kind === "none") {
        return {};
    }
    return { texture: kind, intensity: clampTextureIntensity(look.intensity) };
}

export function withTexture(look: WindowLook, texture: TextureKind, intensity?: number): WindowLook {
    const base = look ?? OpaqueLook;
    return {
        opacity: base.opacity,
        blur: base.blur,
        ...lookTexture({ texture, intensity: intensity ?? base.intensity }),
    };
}

export function minOpacity(blur: boolean): number {
    return blur ? MinOpacityBlur : MinOpacity;
}

// A value the slider can hold: between the readable minimum and 1, on its steps.
export function clampOpacity(value: number, blur: boolean): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 1;
    }
    const min = minOpacity(blur);
    const stepped = Math.round(value / OpacityStep) * OpacityStep;
    return Math.round(Math.min(1, Math.max(min, stepped)) * 100) / 100;
}

export function parseLook(value: any): WindowLook {
    if (value == null || typeof value !== "object") {
        return null;
    }
    if (typeof value.opacity !== "number" || !Number.isFinite(value.opacity)) {
        return null;
    }
    const blur = value.blur === true;
    return { opacity: clampOpacity(value.opacity, blur), blur, ...lookTexture(value) };
}

export function readWorkspaceLook(ws: { meta?: Record<string, any> }): WindowLook {
    return parseLook(ws?.meta?.[WindowLookMetaKey]);
}

export function readProjectLooks(clientMeta: Record<string, any>): Record<string, WindowLook> {
    const value = clientMeta?.[ProjectLooksMetaKey];
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const rtn: Record<string, WindowLook> = {};
    for (const [dir, look] of Object.entries(value)) {
        const parsed = parseLook(look);
        if (dir !== "" && parsed != null) {
            rtn[dir] = parsed;
        }
    }
    return rtn;
}

export function readProjectLook(clientMeta: Record<string, any>, projectDir: string): WindowLook {
    if (!projectDir) {
        return null;
    }
    return readProjectLooks(clientMeta)[projectDir] ?? null;
}

// Wave's global settings: translucent only when window:transparent or window:blur is on.
export function globalLook(settings: Record<string, any>): WindowLook {
    const transparent = settings?.["window:transparent"] === true;
    const blur = settings?.["window:blur"] === true;
    if (!transparent && !blur) {
        return OpaqueLook;
    }
    const raw = settings?.["window:opacity"];
    return { opacity: clampOpacity(typeof raw === "number" ? raw : GlobalDefaultOpacity, blur), blur };
}

// Workspace over project over global.
export function resolveLook(
    workspace: WindowLook,
    project: WindowLook,
    global: WindowLook
): { look: WindowLook; source: LookSource } {
    if (workspace != null) {
        return { look: workspace, source: "workspace" };
    }
    if (project != null) {
        return { look: project, source: "project" };
    }
    return { look: global ?? OpaqueLook, source: "global" };
}

// The look of the workspace a window shows: each tab view computes its own workspace's, so switching workspaces
// switches the look with the view.
export function lookForWorkspace(
    ws: { meta?: Record<string, any> },
    projectDir: string,
    clientMeta: Record<string, any>,
    settings: Record<string, any>
): { look: WindowLook; source: LookSource } {
    return resolveLook(readWorkspaceLook(ws), readProjectLook(clientMeta, projectDir), globalLook(settings));
}

// Where a change is saved: the project while the workspace follows its project's look, else the workspace.
export function lookScope(workspace: WindowLook, project: WindowLook, hasProject: boolean): LookScope {
    return workspace == null && project != null && hasProject ? "project" : "workspace";
}

export type LookSupport = { translucent: boolean; blur: boolean };
export type OpaqueReason = "reducedTransparency" | "unsupported";

// What the window draws: the resolved look, unless the system asks for less transparency or this window cannot be
// see-through; then opaque, with the reason the control shows. The texture is kept either way (#1294): it needs no
// see-through window.
export function effectiveLook(
    look: WindowLook,
    reducedTransparency: boolean,
    support: LookSupport
): { look: WindowLook; reason: OpaqueReason } {
    const wanted = look ?? OpaqueLook;
    const opaque = { ...OpaqueLook, ...lookTexture(wanted) };
    if (wanted.opacity >= 1 && !wanted.blur) {
        return { look: opaque, reason: null };
    }
    if (reducedTransparency) {
        return { look: opaque, reason: "reducedTransparency" };
    }
    if (!support?.translucent) {
        return { look: opaque, reason: "unsupported" };
    }
    const blur = wanted.blur && support.blur;
    return { look: { opacity: clampOpacity(wanted.opacity, blur), blur, ...lookTexture(wanted) }, reason: null };
}

// The ink a drawn look's texture takes (window-texture.ts): dark over a see-through frame, light over an opaque one.
export function textureTone(drawn: WindowLook): TextureTone {
    return isTranslucent(drawn) ? "dark" : "light";
}

export function isTranslucent(look: WindowLook): boolean {
    return look != null && (look.opacity < 1 || look.blur);
}

// The meta writes for a change of look: on the workspace, or on the project (the workspace's own value is let go so the
// project's applies, and every workspace on the project follows it).
export function lookWrites(
    scope: LookScope,
    look: WindowLook,
    projectDir: string,
    clientMeta: Record<string, any>
): { workspace?: Record<string, any>; client?: Record<string, any> } {
    if (scope === "project" && projectDir) {
        const looks = { ...readProjectLooks(clientMeta), [projectDir]: look };
        return { workspace: { [WindowLookMetaKey]: null }, client: { [ProjectLooksMetaKey]: looks } };
    }
    return { workspace: { [WindowLookMetaKey]: look } };
}

// Percent shown by the slider.
export function opacityPercent(opacity: number): number {
    return Math.round((opacity ?? 1) * 100);
}
