// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the arranging mode lays over the dashboard's own blocks (FR-SHELL-018, #2467). The blocks are the ones of the
// normal view, with their real content: while the mode lasts, the dashboard provides this and each block reads it by its
// id, to wear the controls on its top border (the handle, the eye, full width, settings) in place of its own tools, and
// to be held still under them. Outside the mode the value is null and a block is exactly what it was. Kept apart from the
// block, which every section imports, so that it carries no more than the type.

import { createContext } from "react";

export type BlockChrome = {
    // The keyboard's handle, on the block's top border between its label and its tools; absent on a hidden block.
    grip: React.ReactNode;
    // The block's buttons while arranging, which replace its own tools.
    tools: React.ReactNode;
    // What the mode says on the block's element (its section, its span, whether it is carried or hidden).
    attrs: Record<string, string>;
};

export type ArrangeValue = {
    // The controls of the section with this id; null for a block the mode does not arrange.
    chromeOf: (id: string) => BlockChrome;
};

export const ArrangeContext = createContext<ArrangeValue>(null);
