// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pinning a carpet panel from its header, its menus and the keyboard (FR-SHELL-067). A carpet panel's header shows a
// pin button that offers both pins; a pinned panel shows a filled pin that unpins it and a small "pinned" badge.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { IconButton } from "@/element/iconbutton";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { memo } from "react";
import { useLocale } from "../i18n/i18n";
import { acceleratorById, formatShortcutById } from "../shortcuts/format";
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

export const PinHeaderButton = memo(({ blockId }: { blockId: string }) => {
    useLocale();
    const placement = usePanelPlacement(blockId);
    if (placement == null || placement === "first") {
        return null;
    }
    const pinned = isPinned(placement);
    const shortcut = formatShortcutById("pin-panel");
    const title = `${pinned ? PinText.unpinButton : PinText.pinButton}${shortcut ? ` (${shortcut})` : ""}`;
    const decl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "thumbtack",
        title,
        click: (e) => {
            e?.stopPropagation();
            if (pinned) {
                currentView360()?.unpin(blockId);
                return;
            }
            ContextMenuModel.getInstance().showContextMenu(pinMenuItems(blockId, ""), e);
        },
    };
    return (
        <>
            {pinned && (
                <span className="mt-pinned-badge" data-testid="mt-pinned-badge">
                    {PinText.pinnedBadge}
                </span>
            )}
            <IconButton decl={decl} className={cn("mt-pin-button", pinned && "is-pinned")} />
        </>
    );
});
PinHeaderButton.displayName = "PinHeaderButton";
