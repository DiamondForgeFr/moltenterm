// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The mark of a panel that runs hidden (#916, hidden-panel.ts), apart so the layout model can read it without
// importing the layout helpers.

// must match pkg/molten/mcpreview/wire.go
export const HiddenMetaKey = "molten:hidden";

export function isHiddenMeta(meta: MetaType): boolean {
    return (meta as Record<string, unknown>)?.[HiddenMetaKey] === true;
}
