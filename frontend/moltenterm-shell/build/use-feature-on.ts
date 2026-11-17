// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The gates of the window as hooks (FR-BOSS-011, #2254). The hook of a gated feature reads the developer's switches with
// useNarrowing(), so a surface that stays on screen redraws when a switch changes, and answers what current-build.ts
// gives to a menu opened later, so the two never disagree. The brainstorm has no switch since it shipped on every channel
// (#2320): its hooks only read the channel, which never changes while the app runs.

import { useMemo } from "react";
import { currentBrainstormAllowed, currentBrainstormGates } from "./current-build";

export function useBrainstormAllowed(): boolean {
    return currentBrainstormAllowed();
}

export function useBrainstormGates(): { start: boolean; replay: boolean } {
    return useMemo(() => currentBrainstormGates(), []);
}
