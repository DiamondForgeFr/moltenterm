// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The global command palette (FR-SHELL-013): the same palette as an empty pane, over the tab, through Wave's modal
// system. Enter fills the focused pane when it is empty (a launcher), else opens a new pane; Tab opens to the right
// of the focused pane.

import { getBlockComponentModel, getFocusedBlockId } from "@/app/store/global";
import { globalRefocusWithTimeout } from "@/app/store/keymodel";
import { useState } from "react";
import { CommandPalette } from "./command-palette";
import { PalettePlacement } from "./palette-actions";
import { closeCommandPalette, CommandPaletteModalName } from "./palette-keys";

type PaletteOrigin = { blockId: string; inPlace: PalettePlacement };

function readOrigin(): PaletteOrigin {
    const blockId = getFocusedBlockId();
    const view = blockId ? getBlockComponentModel(blockId)?.viewModel?.viewType : null;
    return { blockId, inPlace: view === "launcher" ? "replace" : "new" };
}

export function MoltentermCommandPaletteModal() {
    const [origin] = useState(readOrigin);
    const close = (reason: "open" | "dismiss") => {
        closeCommandPalette();
        if (reason === "dismiss") {
            globalRefocusWithTimeout(10);
        }
    };
    return (
        <div
            className="fixed inset-0 z-[9000] flex items-start justify-center bg-black/40 px-4 pt-[14vh]"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    e.preventDefault();
                    close("dismiss");
                }
            }}
        >
            <CommandPalette
                host="modal"
                blockId={origin.blockId}
                inPlace={origin.inPlace}
                autoFocus={true}
                onClose={close}
            />
        </div>
    );
}

MoltentermCommandPaletteModal.displayName = CommandPaletteModalName;
