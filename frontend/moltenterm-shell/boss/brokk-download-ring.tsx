// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The download on Brokk's face (FR-BOSS-009, AC34 to AC36, #2083): a thin ring around the face while a download runs, in
// the ember of the rail's download ring, and the words the face's name and tooltip say about it. The ring and the words
// read the downloads store and its progress helper, the rail's own source. The ring stands still: reduced motion loses
// nothing, since it never turns.

import type { DownloadRecord } from "../downloads/downloads-model";
import { downloadRingOf } from "../downloads/downloads-model";
import { useTCount } from "../i18n/i18n";
import { AvatarVariant, downloadRingRadiusUnits, RingStrokeUnits, RingUnits } from "./brokk-avatar-model";

// A quarter arc stands for a download whose size is not known, as the rail's ring does.
const IndeterminateArc = 0.25;

// The words of the running downloads: "1 download running, 13 %", or without a percentage while no size is known. Null
// while none runs. The hook is called before any early return, so that it stays on every render.
export function useDownloadWords(running: DownloadRecord[]): string | null {
    const tCount = useTCount();
    const ring = downloadRingOf(running);
    if (ring == null) {
        return null;
    }
    if (ring < 0) {
        return tCount("boss.avatar.downloadUnknown", running.length);
    }
    return tCount("boss.avatar.downloadKnown", running.length, { percent: Math.round(ring * 100) });
}

// A thin arc around the working ring, concentric with it and 2 px outside it, at the overall progress; a quarter arc while
// the size of the running downloads is unknown. Its box is the working ring's, and it overflows that box to draw there.
export function AvatarDownloadRing({ ring, variant }: { ring: number; variant: AvatarVariant }) {
    const radius = downloadRingRadiusUnits(variant);
    const length = 2 * Math.PI * radius;
    const shown = ring >= 0 ? ring : IndeterminateArc;
    return (
        <svg
            aria-hidden
            viewBox={`0 0 ${RingUnits} ${RingUnits}`}
            className="mt-brokk-download"
            data-testid="brokk-download-ring"
        >
            <circle
                cx={RingUnits / 2}
                cy={RingUnits / 2}
                r={radius}
                fill="none"
                stroke="var(--mt-state-running)"
                strokeWidth={RingStrokeUnits}
                strokeLinecap="round"
                strokeDasharray={`${shown * length} ${length}`}
            />
        </svg>
    );
}
