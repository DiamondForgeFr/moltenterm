// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm ships no built-in AI (FR-MORPH-008): the coding agent the user runs in a terminal is the only AI in the
// workspace. Wave's AI panel stays in the tree, unreachable, so that upstream merges stay simple; the patched Wave
// files check this constant where the panel could open.
export const MoltentermNoAI = true;

// The first-run feature tour skips its Wave AI page, so the steps of the other pages start one lower.
export const MoltentermOnboardingSkippedSteps = MoltentermNoAI ? 1 : 0;
