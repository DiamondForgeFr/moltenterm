// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The split placement mode's rules (#677): four drop zones on the panel, triangles from its centre to each edge, and
// the half of the panel the new panel takes on each side. Pure, so they are tested without the app.

import type { SplitDirection } from "./split-model";

export const SplitSides: SplitDirection[] = ["up", "right", "down", "left"];

// The zone under a point of the panel: the side whose edge is nearest, relative to the panel's size, which draws the
// four triangles meeting at the centre. Null outside the panel.
export function zoneAt(x: number, y: number, width: number, height: number): SplitDirection {
    if (!(width > 0 && height > 0) || x < 0 || y < 0 || x > width || y > height) {
        return null;
    }
    const u = x / width;
    const v = y / height;
    const distances: [SplitDirection, number][] = [
        ["left", u],
        ["right", 1 - u],
        ["up", v],
        ["down", 1 - v],
    ];
    let best = distances[0];
    for (const d of distances) {
        if (d[1] < best[1]) {
            best = d;
        }
    }
    return best[0];
}

const ArrowSides: Record<string, SplitDirection> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
};

// The side an arrow key picks, or null for any other key.
export function sideForKey(key: string): SplitDirection {
    return ArrowSides[key] ?? null;
}

// The triangle of a zone, in a 100 x 100 box stretched over the panel.
export function zonePoints(side: SplitDirection): string {
    switch (side) {
        case "up":
            return "0,0 100,0 50,50";
        case "right":
            return "100,0 100,100 50,50";
        case "down":
            return "0,100 100,100 50,50";
        default:
            return "0,0 0,100 50,50";
    }
}

// The half of the panel the new panel takes: the insets of the preview, in percent of the panel.
export function previewInsets(side: SplitDirection): { top: string; right: string; bottom: string; left: string } {
    const rtn = { top: "0%", right: "0%", bottom: "0%", left: "0%" };
    switch (side) {
        case "left":
            rtn.right = "50%";
            break;
        case "right":
            rtn.left = "50%";
            break;
        case "up":
            rtn.bottom = "50%";
            break;
        case "down":
            rtn.top = "50%";
            break;
    }
    return rtn;
}

// The i18n key of a side's label in the preview ("New panel on the left").
export function placeLabelKey(side: SplitDirection): string {
    return `split.place.${side}`;
}
