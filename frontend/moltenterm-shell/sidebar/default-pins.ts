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
        namekey: p.nameKey,
        rev: 1,
        config: { tree: { pane: 0 }, panes: [{ ...p.meta }] },
    }));
}

// The names the seeding wrote before pins kept their key (#1307), in every interface language of the time: a pin
// still named so, with its default panel among its panels ("Update the pinned view" may have added others), was
// seeded and never renamed.
const LegacySeedNames: Record<string, string[]> = {
    "palette.panelNames.terminal": ["Terminal"],
    "palette.panelNames.browser": ["Web page", "Page web"],
    "palette.panelNames.reviews": ["Control room", "Pilotage"],
    "palette.panels.missionControl": ["Project", "Projet"],
};

// The key a pin's shown name follows: its own, or the default it was seeded as before pins kept their key.
export function seededNameKey(pin: GlobalPin): string {
    if (pin?.namekey) {
        return pin.namekey;
    }
    const views = (pin?.config?.panes ?? []).map((pane) => pane?.view);
    const seed = DefaultPins.find(
        (p) => views.includes(p.meta.view) && (LegacySeedNames[p.nameKey] ?? []).includes(pin?.name)
    );
    return seed?.nameKey ?? null;
}

// The pin under a name the developer typed: it no longer follows the interface language.
export function typedNamePin(pin: GlobalPin, name: string): GlobalPin {
    const { namekey: _, ...rest } = pin;
    return { ...rest, name };
}

// The pin as shown: a seeded name in the interface language, a name the developer typed as typed. The key is kept on
// the pin so the next write stores it (the migration of pins seeded before #1307).
export function localizedPin(pin: GlobalPin, t: (key: string) => string): GlobalPin {
    const key = seededNameKey(pin);
    if (!key) {
        return pin;
    }
    const text = t(key);
    const name = text && text !== key ? text : pin.name;
    return name === pin.name && pin.namekey === key ? pin : { ...pin, name, namekey: key };
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
