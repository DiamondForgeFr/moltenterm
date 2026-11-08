// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A character's clips keep their names in the build (FR-BOSS-007). The shared character package reads a character's loops,
// transitions and gestures from one folder (`<folder>/listening.webm`, `<folder>/listening-to-thinking.webm`...) and
// builds each file name itself, so Vite's `assets/<name>-<hash>.webm` leaves it nothing to find. The clips of a
// character, those under a `portrait/<character>/` folder of the sources, are emitted to
// `assets/portrait/<character>/<name>.webm` instead; every other asset keeps Vite's names.
//
// Naming them is not enough: Rollup merges the assets that hold the same bytes into one file, and a character's clips
// repeat each other on purpose (the nod is the same clip in the listening and the speaking pose, and so are the clips
// that carry him to and from a pose that looks alike). The merged name would be the only one left, and the package
// would not find the others. An asset emitted under its own file name is never merged, so the clips are emitted so.

import { readFileSync } from "node:fs";

const ClipPattern = /(?:^|\/)portrait\/([^/]+)\/([^/]+\.webm)$/;

// The path and file a clip is emitted as, or null for any other module.
export function clipOutput(id: string): { fileName: string; file: string } {
    const file = (id ?? "").replace(/\?.*$/, "");
    const match = ClipPattern.exec(file.replace(/\\/g, "/"));
    return match == null ? null : { fileName: `assets/portrait/${match[1]}/${match[2]}`, file };
}

type EmittingContext = { emitFile: (asset: { type: "asset"; fileName: string; source: Buffer }) => string };

export function moltentermStableClips() {
    return {
        name: "moltenterm-stable-clips",
        apply: "build" as const,
        enforce: "pre" as const,
        load(this: EmittingContext, id: string) {
            const clip = clipOutput(id);
            if (clip == null) {
                return null;
            }
            const reference = this.emitFile({ type: "asset", fileName: clip.fileName, source: readFileSync(clip.file) });
            return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
        },
    };
}
