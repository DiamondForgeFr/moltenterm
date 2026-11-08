// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The card's button styles (FR-BOSS-002, FR-BOSS-003), shared by its rows: a primary action in the orange style, the rest
// calm.

import { cn } from "@/util/util";

export const GhostButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
export const GoButton = cn(GhostButton, "molten-tone-accent");
export const SecondaryButton =
    "molten-btn-secondary cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
export const PrimaryButton =
    "molten-btn cursor-pointer rounded-6 px-2.5 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
// A refusal stays a calm button: the danger shows in its text, never as a fill.
export const RefuseButton = cn(SecondaryButton, "text-danger");
