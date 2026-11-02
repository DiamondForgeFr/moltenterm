// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Store on the carpet" in the command panel of every panel outside the fixed zone (FR-SHELL-123-AC12): the chooser's
// offered numbers only (FR-SHELL-049), with the same message and Undo, and in 360 view the pins and Leave.

import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { t, tCount } from "../../i18n/i18n";
import { formatShortcutById } from "../../shortcuts/format";
import { headerPlacement } from "../../view360/view360-places";
import type { View360Model } from "../../view360/view360-model";
import { CommandProvider, PanelContext, PanelItem, PanelSection } from "../panel-types";

function view360Of(): View360Model {
    return getLayoutModelForStaticTab()?.moltenView360 ?? null;
}

export function carpetPlacesItems(view360: View360Model, blockId: string): PanelItem[] {
    if (view360 == null) {
        return [];
    }
    const active = globalStore.get(view360.activeAtom);
    const placement = headerPlacement(
        active,
        globalStore.get(view360.placementsAtom),
        globalStore.get(view360.rolesAtom),
        blockId
    );
    if (placement == null || placement === "first") {
        return [];
    }
    const items: PanelItem[] = [];
    if (placement === "carpet") {
        const shown = globalStore.get(view360.shownPlacesAtom);
        for (const option of view360.placeOptions().filter((o) => o.offered)) {
            items.push({
                id: `molten:places:${option.n}`,
                type: "action",
                label: tCount("view360.places.menuChoice", option.n),
                detail: shown === option.n ? t("view360.places.current") : t("view360.places.mark", { count: option.n }),
                icon: "table-columns",
                keywords: ["360", "carpet", "visible panels", "tabs"],
                run: () => {
                    view360.applyPlaces(blockId, option.n);
                },
            });
        }
    }
    if (!active) {
        return items;
    }
    if (placement !== "beside") {
        items.push({
            id: "molten:places:pin-beside",
            type: "action",
            label: t("view360.places.pinBeside"),
            icon: "thumbtack",
            shortcut: placement === "carpet" ? formatShortcutById("pin-panel") : undefined,
            run: () => {
                view360.pin(blockId, "beside");
            },
        });
    }
    if (placement !== "stacked") {
        items.push({
            id: "molten:places:pin-stacked",
            type: "action",
            label: t("view360.places.pinStacked"),
            icon: "layer-group",
            run: () => {
                view360.pin(blockId, "stacked");
            },
        });
    }
    if (placement === "beside" || placement === "stacked") {
        items.push({
            id: "molten:places:unpin",
            type: "action",
            label: t("view360.places.unpin"),
            icon: "thumbtack-slash",
            shortcut: formatShortcutById("pin-panel"),
            run: () => {
                view360.unpin(blockId);
            },
        });
    }
    items.push({
        id: "molten:places:leave",
        type: "action",
        label: t("view360.places.leave"),
        icon: "table-columns",
        run: () => {
            view360.requestLeave();
        },
    });
    return items;
}

export function carpetPlacesSections(ctx: PanelContext): PanelSection[] {
    const items = carpetPlacesItems(view360Of(), ctx.blockId);
    if (!items.length) {
        return [];
    }
    return [{ id: "molten:places", kind: "molten", title: t("view360.places.title"), items }];
}

export const CarpetPlacesProvider: CommandProvider = {
    id: "molten-places",
    kind: "molten",
    order: 10,
    sections: carpetPlacesSections,
};
