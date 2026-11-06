// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk, declared to the shared character package (FR-BOSS-007, AC1; @diamondforge/character, as Geargrim is in
// DiamondForge): a plain object spread on the package's portrait, built from his manifest (portrait/brokk/
// brokk-manifest.json, the file DiamondForge validated with his clips). It is imported only by the live portrait
// (brokk-live.tsx), which loads on the first opening of the comm screen, so neither the package nor a clip is read
// before that.
//
// His resting pose is called `rest`, as in his manifest: the package takes the name of a character's resting pose from
// its declaration (`restState`, since v0.2.0) and looks for that pose's clips under it (`rest.webm`,
// `rest-to-listening.webm`, `listening-to-rest.webm`...).

import type {
    TransmissionIdle,
    TransmissionIdleGap,
    TransmissionPortraitProps,
    TransmissionState,
    TransmissionTransition,
} from "@diamondforge/character";
import type { BlinkRhythm } from "./brokk-scene";
import Manifest from "./portrait/brokk/brokk-manifest.json";
import Still from "./portrait/brokk/brokk.jpg";

export const RestState = "rest";

type Rest = typeof RestState;

// The rhythm the scene wants for his blinks (brokk-scene.ts), as the package's `idleGap`: how long a gesture drawn by
// chance waits after the last one started (FR-BOSS-007, AC17). A gesture takes the place of a whole turn of a loop, and
// the package lines it up one turn ahead, so with the 4.5 s loops the first start possible is 13.5 s after the last
// one: measured in a test instance, the normal gap gives 13.5 s every time (18 s now and then), the calm one from
// 13.5 s to 31.5 s.
//
// Normal is the one the developer's brief gave (6 to 14 s). Calm is the slowest of the three gaps the developer weighed
// (3 to 8, 6 to 14, 12 to 30): it is for when he should not draw an eye (late at night, while the developer types,
// after a long thought), and its gaps average 22 s against 13.5 s. It stops at 30 s because a face that never blinks
// for longer reads as a frozen screen, not as a calm one.
export const IdleGaps: Record<BlinkRhythm, TransmissionIdleGap> = {
    normal: { minMs: 6000, maxMs: 14000 },
    calm: { minMs: 12000, maxMs: 30000 },
};

type PackageRhythmProps = Pick<TransmissionPortraitProps<Rest>, "idleGap">;

const PackageRhythm: Record<BlinkRhythm, PackageRhythmProps> = {
    normal: { idleGap: IdleGaps.normal },
    calm: { idleGap: IdleGaps.calm },
};

// The same object for the same rhythm: a change of rhythm is the only thing that changes the prop, and the package
// applies it at once.
export function rhythmProps(rhythm: BlinkRhythm): PackageRhythmProps {
    return PackageRhythm[rhythm];
}

export type BrokkManifest = {
    still: string;
    states: readonly string[];
    transitions: readonly string[];
    samePose?: readonly string[];
    idles: Record<string, readonly { name: string; weight?: number; onDemand?: boolean; repeat?: boolean }[]>;
    expressionMs: Record<string, number>;
    head: { x: number; y: number; bubbleZoom: number };
};

export type BrokkDeclaration = Pick<
    TransmissionPortraitProps<Rest>,
    "src" | "loops" | "restState" | "transitions" | "idles"
>;

// The clips the declaration names, by file name without extension, the way the package looks for them: a loop per
// state, the transitions and the gestures.
export function clipNames(declaration: BrokkDeclaration): string[] {
    const names: string[] = ["listening", "thinking", "speaking", declaration.restState];
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
    const known = (state: string) => manifest.states.includes(state);
    const transitions = manifest.transitions
        .map((transition) => transition.split(">"))
        .filter(([from, to]) => known(from) && known(to))
        .map((pair) => pair.join(">") as TransmissionTransition<Rest>);
    const idles: Partial<Record<TransmissionState<Rest>, TransmissionIdle[]>> = {};
    for (const [state, list] of Object.entries(manifest.idles)) {
        if (!known(state)) {
            continue;
        }
        idles[state as TransmissionState<Rest>] = list.map((idle) => ({
            name: idle.name,
            ...(idle.weight != null ? { weight: idle.weight } : {}),
            ...(idle.onDemand ? { onDemand: true } : {}),
            ...(idle.repeat ? { repeat: true } : {}),
        }));
    }
    return { src: still, loops, restState: RestState, transitions, idles };
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
