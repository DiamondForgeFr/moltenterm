// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Anything the interface can do, a command can do" (FR-SHELL-047): the command palette lists the items of the
// command panel of the pane it was opened from (actions, toggles, each value of a choice) while a query is typed,
// and an entry that opens that panel.

import { fireAndForget } from "@/util/util";
import type { PaletteEntry } from "../palette/palette-model";
import { openCommandPanel } from "./command-panel-store";
import { makePanelContext } from "./panel-context";
import { effectiveValue, FlatPanelEntry, flattenPanel, setItemValue } from "./panel-model";
import { collectPanel } from "./panel-registry";
import { registerBuiltinCommandProviders } from "./providers";

function panelEntriesOf(blockId: string): { panelName: string; entries: FlatPanelEntry[] } {
    registerBuiltinCommandProviders();
    const ctx = blockId ? makePanelContext(blockId) : null;
    if (ctx == null) {
        return { panelName: null, entries: [] };
    }
    return { panelName: ctx.panelName, entries: flattenPanel(collectPanel(ctx).sections) };
}

export function panelPaletteEntries(blockId: string, hint: string): PaletteEntry[] {
    const { panelName, entries } = panelEntriesOf(blockId);
    if (panelName == null) {
        return [];
    }
    const open: PaletteEntry = {
        id: "panel:open",
        group: "panel",
        label: `${panelName} commands and options…`,
        icon: "sliders",
        hint,
        keywords: ["settings", "gear", "options", "command panel"],
        run: { kind: "panelcommands" },
    };
    return [
        open,
        ...entries.map(
            (e): PaletteEntry => ({
                id: `panel:${e.id}`,
                group: "panel",
                label: e.item.type === "number" ? `${e.label}…` : e.label,
                detail: e.breadcrumb,
                icon: e.icon ?? "sliders",
                hint: e.shortcut,
                run: { kind: "panelcommand", entryId: e.id },
            })
        ),
    ];
}

export function openPanelFromPalette(blockId: string) {
    if (blockId) {
        openCommandPanel(blockId, "palette");
    }
}

// Runs a panel item as the panel would: an action runs, a toggle flips, a choice's value is set at its preferred
// scope (the panel itself offers the others).
export async function runPanelPaletteEntry(blockId: string, entryId: string): Promise<void> {
    const entry = panelEntriesOf(blockId).entries.find((e) => e.id === entryId);
    if (entry == null) {
        return;
    }
    const item = entry.item;
    if (entry.option != null && item.type === "choice") {
        if (entry.option.run != null) {
            await entry.option.run();
        } else {
            await setItemValue(item, entry.option.value);
        }
        return;
    }
    if (item.type === "action") {
        fireAndForget(async () => item.run());
        return;
    }
    if (item.type === "toggle") {
        await setItemValue(item, !effectiveValue(item));
        return;
    }
    if (item.type === "number") {
        openCommandPanel(blockId, "palette", item.label);
    }
}
