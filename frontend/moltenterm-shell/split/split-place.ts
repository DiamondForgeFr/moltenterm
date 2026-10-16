// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The split placement mode (#677): "Split…" (menus, palette, ⇧⌘S) and the edge "+" handles show four drop zones on the
// panel; the chosen side splits it and the new panel opens on the picker, as every split does. One panel at a time.

import { getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { panelIsLaidOut, revealPanelOnCarpet } from "../view360/carpet-reveal";
import { splitPanel } from "./split";
import type { SplitDirection } from "./split-model";

// side: the zone shown as chosen (pointer or arrows), null until one is.
export type SplitPlacement = { blockId: string; side: SplitDirection };

export const splitPlacementAtom = atom(null) as PrimitiveAtom<SplitPlacement>;

// The panel first comes into view on the 360 carpet (#747); a block the tab draws no panel for gets no mode, which
// would swallow the arrows with nothing on screen.
export function enterSplitPlacement(blockId: string, side: SplitDirection = null): void {
    if (!panelIsLaidOut(blockId)) {
        return;
    }
    revealPanelOnCarpet(blockId);
    globalStore.set(splitPlacementAtom, { blockId, side });
}

export function enterSplitPlacementFocused(): void {
    enterSplitPlacement(getFocusedBlockId());
}

export function setSplitPlacementSide(side: SplitDirection): void {
    const current = globalStore.get(splitPlacementAtom);
    if (current == null || side == null || current.side === side) {
        return;
    }
    globalStore.set(splitPlacementAtom, { ...current, side });
}

export function cancelSplitPlacement(): void {
    if (globalStore.get(splitPlacementAtom) != null) {
        globalStore.set(splitPlacementAtom, null);
    }
}

// Splits on the given side, or the chosen one; nothing happens while no side is chosen.
export function confirmSplitPlacement(side?: SplitDirection): void {
    const current = globalStore.get(splitPlacementAtom);
    const chosen = side ?? current?.side;
    if (current == null || chosen == null) {
        return;
    }
    globalStore.set(splitPlacementAtom, null);
    fireAndForget(() => splitPanel(current.blockId, chosen));
}
