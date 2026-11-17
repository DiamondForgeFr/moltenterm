// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the tests of the 360 view model put in place of the ScreenModel (./screen-store): the threshold atom they drive,
// a screen the window is on (none by default) and the offer to save it (#2180), with the calls it received.

import { atom, type Atom, type PrimitiveAtom } from "jotai";
import type { ScreenInfo } from "./screen-threshold";

export type FakeScreens = {
    thresholdAtom: Atom<number>;
    screenAtom: PrimitiveAtom<ScreenInfo>;
    screen: ScreenInfo;
    threshold: number;
    // What saveOffered answers.
    offered: boolean;
    saveOffered: (screen?: ScreenInfo) => boolean;
    setThreshold: (columns: number, screen?: ScreenInfo) => void;
    decline: (screen?: ScreenInfo) => void;
    saved: { columns: number; screen: ScreenInfo }[];
    declined: ScreenInfo[];
};

// `thresholdAtom` is typed loosely because the tests keep it in a hoisted holder, before the mock factory made it.
export function makeFakeScreens(thresholdAtom: unknown, screen: ScreenInfo = null): FakeScreens {
    const fake: FakeScreens = {
        thresholdAtom: thresholdAtom as Atom<number>,
        screenAtom: atom(screen) as PrimitiveAtom<ScreenInfo>,
        screen,
        threshold: 2,
        offered: false,
        saveOffered: () => fake.offered && fake.screen != null,
        setThreshold: (columns, target = fake.screen) => void fake.saved.push({ columns, screen: target }),
        decline: (target = fake.screen) => void fake.declined.push(target),
        saved: [],
        declined: [],
    };
    return fake;
}
