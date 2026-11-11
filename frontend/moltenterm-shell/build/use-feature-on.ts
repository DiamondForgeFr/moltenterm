// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The gates of the window as hooks (FR-BOSS-011, #2254): a surface that stays on screen while the developer turns a
// feature off in Features in test redraws when the switch changes. The answer is the one current-build.ts gives to a
// menu opened later, so the two never disagree.

import { useMemo } from "react";
import { currentBrainstormAllowed, currentBrainstormGates } from "./current-build";
import { useNarrowing } from "./features-narrowing";

export function useBrainstormAllowed(): boolean {
    useNarrowing();
    return currentBrainstormAllowed();
}

export function useBrainstormGates(): { start: boolean; replay: boolean } {
    const narrowing = useNarrowing();
    return useMemo(() => currentBrainstormGates(), [narrowing]);
}
