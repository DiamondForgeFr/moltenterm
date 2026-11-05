// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk, declared to the shared character package (FR-BOSS-007, AC1; @diamondforge/character, as Geargrim is in
// DiamondForge): a plain object spread on the package's portrait, built from his manifest (portrait/brokk/
// brokk-manifest.json, the file DiamondForge validated with his clips). It is imported only by the live portrait
// (brokk-live.tsx), which loads on the first opening of the comm screen, so neither the package nor a clip is read
// before that.
//
// One name differs from the manifest. Version 0.1.0 of the package names a character's resting pose `offline`, plays no
// other, and looks for its clips under that name: `offline.webm`, `offline-to-listening.webm`, `listening-to-offline.webm`
// and so on. MoltenTerm and the manifest call that pose `rest` (BrokkPose), so the seam below is the one place that
// translates, and the seven clips of the pose are stored under the package's name. When the package names the pose
// `rest`, PackageStateOf and those file names are all that change.

import type {
    TransmissionIdle,
    TransmissionPortraitProps,
    TransmissionState,
    TransmissionTransition,
} from "@diamondforge/character";
import type { BrokkPose } from "./brokk-state-model";
import Manifest from "./portrait/brokk/brokk-manifest.json";
import Still from "./portrait/brokk/brokk.jpg";

const PackageStateOf: Record<string, TransmissionState> = {
    listening: "listening",
    thinking: "thinking",
    speaking: "speaking",
    rest: "offline",
};

export function packageState(pose: BrokkPose): TransmissionState {
    return PackageStateOf[pose];
}

export type BrokkManifest = {
    still: string;
    states: readonly string[];
    transitions: readonly string[];
    samePose?: readonly string[];
    idles: Record<string, readonly { name: string; weight?: number; onDemand?: boolean }[]>;
    expressionMs: Record<string, number>;
    head: { x: number; y: number; bubbleZoom: number };
};

export type BrokkDeclaration = Pick<TransmissionPortraitProps, "src" | "loops" | "transitions" | "idles">;

function known(state: string): boolean {
    return PackageStateOf[state] != null;
}

// The clips the declaration names, by file name without extension, the way the package looks for them: a loop per
// state, the transitions and the gestures.
export function clipNames(declaration: BrokkDeclaration): string[] {
    const names: string[] = ["listening", "thinking", "speaking", "offline"];
    for (const transition of declaration.transitions ?? []) {
        const [from, to] = transition.split(">");
        names.push(`${from}-to-${to}`);
    }
    for (const [state, idles] of Object.entries(declaration.idles ?? {})) {
        for (const idle of idles) {
            names.push(`${state}.${idle.name}`);
        }
    }
    return names;
}

export function makeBrokkDeclaration(manifest: BrokkManifest, loops: string, still: string): BrokkDeclaration {
    const transitions = manifest.transitions
        .map((transition) => transition.split(">"))
        .filter(([from, to]) => known(from) && known(to))
        .map(([from, to]) => `${PackageStateOf[from]}>${PackageStateOf[to]}` as TransmissionTransition);
    const idles: Partial<Record<TransmissionState, TransmissionIdle[]>> = {};
    for (const [state, list] of Object.entries(manifest.idles)) {
        if (!known(state)) {
            continue;
        }
        idles[PackageStateOf[state]] = list.map((idle) => ({
            name: idle.name,
            ...(idle.weight != null ? { weight: idle.weight } : {}),
            ...(idle.onDemand ? { onDemand: true } : {}),
        }));
    }
    return { src: still, loops, transitions, idles };
}

// Vite gives each clip its own URL; the package wants one folder to read them all from. The build keeps the clips
// together under their own names (moltentermStableClips, build/stable-clips.ts), so their folder is the one every URL
// shares. Without clips, or when they are apart, there is no folder and the still plays the part.
export function clipsFolder(urls: Record<string, string>): string {
    const folders = new Set(Object.values(urls).map((url) => url.slice(0, url.lastIndexOf("/"))));
    return folders.size === 1 && !folders.has("") && Object.values(urls).every((url) => !url.startsWith("data:"))
        ? [...folders][0]
        : undefined;
}

const Clips = import.meta.glob("./portrait/brokk/*.webm", {
    query: "?url",
    import: "default",
    eager: true,
}) as unknown as Record<string, string>;

export const BrokkPortrait: BrokkDeclaration = makeBrokkDeclaration(Manifest, clipsFolder(Clips), Still);
