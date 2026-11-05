// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The pull requests the Integration panel holds, and the PRs marked ready from MoltenTerm (#687), as shared atoms (FR-BOSS-003).
// This module imports nothing at run time: the boss card reads these atoms without loading the review stores, whose import
// chain reaches the card back, and that cycle left modules half-loaded in the tests. The stores own them through these.

import { atom, PrimitiveAtom } from "jotai";
import type { ReadiedPrs, ReviewsAnswer } from "./reviews-model";

export const SharedReviewsAnswersAtom = atom({}) as PrimitiveAtom<Record<string, ReviewsAnswer>>;

export const SharedReadiedAtom = atom({}) as PrimitiveAtom<ReadiedPrs>;
