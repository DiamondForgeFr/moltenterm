// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pinning a carpet panel from its menus and the keyboard (FR-SHELL-067). The header's pins moved into the chooser of
// "Store on the carpet" (FR-SHELL-123, view360-places.tsx); a pinned panel keeps its filled pin there.

import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { atom, useAtomValue } from "jotai";
import { acceleratorById } from "../shortcuts/format";
import { PinText } from "./pin-text";
import type { PanelPlacement, View360Model } from "./view360-model";

export const PinKey = "Cmd:Shift:p";

const NoPlacements = atom({} as Record<string, PanelPlacement>);

function currentView360(): View360Model {
    return getLayoutModelForStaticTab()?.moltenView360 ?? null;
}

export function isPinned(placement: PanelPlacement): boolean {
    return placement === "beside" || placement === "stacked";
}

export type PinAction = { id: string; label: string; icon: string; run: () => void };

// The pin actions a panel offers where it is: both pins on the carpet, the other pin and Unpin once pinned, nothing
// in the first column or outside 360 view.
export function pinActions(blockId: string): PinAction[] {
    const view360 = currentView360();
    const placement = view360?.placementOf(blockId);
    if (view360 == null || placement == null || placement === "first") {
        return [];
    }
    const rtn: PinAction[] = [];
    if (placement !== "beside") {
        rtn.push({
            id: "pin-beside",
            label: PinText.pinBeside,
            icon: "thumbtack",
            run: () => view360.pin(blockId, "beside"),
        });
    }
    if (placement !== "stacked") {
        rtn.push({
            id: "pin-stacked",
            label: PinText.pinStacked,
            icon: "layer-group",
            run: () => view360.pin(blockId, "stacked"),
        });
    }
    if (isPinned(placement)) {
        rtn.push({ id: "unpin", label: PinText.unpin, icon: "thumbtack-slash", run: () => view360.unpin(blockId) });
    }
    return rtn;
}

// The shortcut pins a carpet panel beside, or unpins a pinned one: it is shown on that entry.
export function pinActionShortcut(actionId: string, placement: PanelPlacement): boolean {
    return (actionId === "pin-beside" && placement === "carpet") || actionId === "unpin";
}

export function pinMenuItems(blockId: string, section: string): ContextMenuItem[] {
    const placement = currentView360()?.placementOf(blockId);
    const accelerator = acceleratorById("pin-panel");
    return pinActions(blockId).map((action) => ({
        label: action.label,
        icon: action.icon,
        section,
        accelerator: pinActionShortcut(action.id, placement) ? accelerator : undefined,
        click: action.run,
    }));
}

// The key pins the focused panel beside, or unpins it; elsewhere it is left to the panel.
export function togglePinFocused(): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const view360 = layoutModel?.moltenView360;
    const focused = layoutModel == null ? null : globalStore.get(layoutModel.focusedNode);
    const blockId = focused?.data?.blockId;
    if (view360 == null || blockId == null) {
        return false;
    }
    return view360.togglePin(blockId);
}

export function registerPinKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(PinKey, () => togglePinFocused());
}

export function usePanelPlacement(blockId: string): PanelPlacement {
    const view360 = currentView360();
    const placements = useAtomValue(view360?.placementsAtom ?? NoPlacements);
    return placements[blockId] ?? null;
}
