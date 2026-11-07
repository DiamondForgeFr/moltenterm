// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The download on Brokk's face (FR-BOSS-009, AC34 to AC36, #2083): a thin ring around the face while a download runs, in
// the ember of the rail's download ring, and the words the face's name and tooltip say about it. The ring and the words
// read the downloads store and its progress helper, the rail's own source. The ring stands still: reduced motion loses
// nothing, since it never turns.

import type { DownloadRecord } from "../downloads/downloads-model";
import { downloadRingOf } from "../downloads/downloads-model";
import { useTCount } from "../i18n/i18n";

// The arc's radius in the 30-unit box of the ring: just outside the face's edge, which the box's own size places.
const RingRadius = 14.25;
const RingLength = 2 * Math.PI * RingRadius;
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

// A thin arc around the face, at the overall progress; a quarter arc while the size of the running downloads is unknown.
export function AvatarDownloadRing({ ring }: { ring: number }) {
    const shown = ring >= 0 ? ring : IndeterminateArc;
    return (
        <svg aria-hidden viewBox="0 0 30 30" className="mt-brokk-download" data-testid="brokk-download-ring">
            <circle
                cx="15"
                cy="15"
                r={RingRadius}
                fill="none"
                stroke="var(--mt-state-running)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={`${shown * RingLength} ${RingLength}`}
            />
        </svg>
    );
}
