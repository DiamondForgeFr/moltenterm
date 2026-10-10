// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The MoltenTerm section of a terminal's command panel (FR-SHELL-049, DS-SHELL-089): MoltenTerm's own actions for
// this panel. An item registers only when its feature exists in the build, so an unshipped one is absent rather than
// disabled; the ticket that ships one adds it here:
// - Morph MoltenTerm… once the palette has a morph flow to open (#163);
// - Continue with another agent ▸ with #331 (FR-CONT-010), opening its agent list;
// - Auto-approve this terminal with #386: a toggle at This panel only, off by default, named by the header Pill;
// - Agent integration (per agent, Everywhere) with #322 (FR-SHELL-040): it writes agent:integrateoff;
// - Link to the workspace task once a terminal can be linked to its workspace's task checkpoint (FR-CONT).
// Shipped: Durable session (the terminal's durability, moved out of Wave's Advanced menu) and Open the companion.

import { getBlockTermDurableAtom, globalStore } from "@/app/store/global";
import { findCompanionBlock, toggleCompanion } from "../../companion/companion-open";
import { formatShortcutById } from "../../shortcuts/format";
import { CommandProvider, PanelContext, PanelItem, PanelSection } from "../panel-types";
import { MoltenWidgetProviders } from "./molten-widgets";

type DurableTermModel = { restartSessionWithDurability?: (durable: boolean) => Promise<void> };

// A page rather than a toggle: either way the shell restarts, which ends what runs in it, so the panel says so first.
export function durableSessionItem(ctx: PanelContext, durable: boolean): PanelItem {
    const restart = (ctx.viewModel as DurableTermModel)?.restartSessionWithDurability;
    if (durable == null || typeof restart !== "function") {
        return null;
    }
    const model = ctx.viewModel as DurableTermModel;
    return {
        id: "molten:durable",
        type: "page",
        label: "Durable session",
        icon: "shield",
        valueLabel: durable ? "On" : "Off",
        keywords: ["durability", "persist", "keep running"],
        items: [
            {
                id: "molten:durable:info",
                type: "info",
                label: durable
                    ? "This shell keeps running when you quit or update MoltenTerm."
                    : "This shell ends when you quit MoltenTerm.",
            },
            {
                id: durable ? "molten:durable:off" : "molten:durable:on",
                type: "action",
                label: durable ? "Restart as a standard session" : "Restart as a durable session",
                detail: "ends what runs in it",
                icon: "rotate-right",
                destructive: true,
                run: () => model.restartSessionWithDurability(!durable),
            },
        ],
    };
}

export function companionItem(ctx: PanelContext, open: boolean): PanelItem {
    if (!ctx.capabilities.has("agent")) {
        return null;
    }
    return {
        id: "molten:companion",
        type: "action",
        label: open ? "Close the companion" : "Open the companion",
        icon: "book-open",
        keywords: ["agent companion", "session", "transcript"],
        shortcut: formatShortcutById("companion"),
        run: () => toggleCompanion(ctx.blockId),
    };
}

export function moltenSections(ctx: PanelContext): PanelSection[] {
    const durable = globalStore.get(getBlockTermDurableAtom(ctx.blockId));
    const items = [
        companionItem(ctx, findCompanionBlock(ctx.blockId) != null),
        durableSessionItem(ctx, durable),
    ].filter((i) => i != null);
    return [{ id: "molten", kind: "molten", title: "MoltenTerm", items }];
}

export const MoltenProvider: CommandProvider = {
    id: "molten",
    kind: "molten",
    needs: ["terminal"],
    sections: moltenSections,
};

// Everything MoltenTerm's own providers add, registered together by the panel host.
export const MoltenProviders: CommandProvider[] = [MoltenProvider, ...MoltenWidgetProviders];
