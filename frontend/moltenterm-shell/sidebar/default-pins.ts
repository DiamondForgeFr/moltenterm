// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A fresh install's top row (FR-SHELL-080, #1296): Terminal, Web page, Pilotage and Project pinned everywhere, each one
// panel, named in the interface language. wavesrv marks a client it creates (pkg/wcore/moltenterm_defaultpins.go); the
// first window that sees the mark writes these pins and clears it, so an existing row, even an empty one, never
// changes.

import { MoltentermBrowserView } from "../browser/browser-model";
import { MoltentermProjectView } from "../project/project-model";
import { MoltentermReviewsView } from "../reviews/reviews-model";
import { GlobalPin, GlobalPinsMetaKey, makeGlobalPinId, readGlobalPins } from "./view-pins-model";

// must match SeedGlobalPinsMetaKey in pkg/wcore/moltenterm_defaultpins.go
export const SeedGlobalPinsMetaKey = "molten:seedglobalpins";

const DefaultPins: { nameKey: string; meta: Record<string, any> }[] = [
    { nameKey: "palette.panelNames.terminal", meta: { view: "term", controller: "shell" } },
    { nameKey: "palette.panelNames.browser", meta: { view: MoltentermBrowserView } },
    { nameKey: "palette.panelNames.reviews", meta: { view: MoltentermReviewsView } },
    { nameKey: "palette.panels.missionControl", meta: { view: MoltentermProjectView } },
];

export function defaultGlobalPins(t: (key: string) => string, now: number, random: () => number): GlobalPin[] {
    return DefaultPins.map((p) => ({
        id: makeGlobalPinId(now, random()),
        name: t(p.nameKey),
        rev: 1,
        config: { tree: { pane: 0 }, panes: [{ ...p.meta }] },
    }));
}

// The client meta to write for a client's meta, or null when there is nothing to do: the defaults only with the mark
// and no pins yet, and the mark cleared either way.
export function seedPinsMeta(
    meta: Record<string, any>,
    t: (key: string) => string,
    now: number,
    random: () => number
): Record<string, any> {
    if (!meta?.[SeedGlobalPinsMetaKey]) {
        return null;
    }
    if (readGlobalPins(meta).length > 0) {
        return { [SeedGlobalPinsMetaKey]: null };
    }
    return { [GlobalPinsMetaKey]: defaultGlobalPins(t, now, random), [SeedGlobalPinsMetaKey]: null };
}
