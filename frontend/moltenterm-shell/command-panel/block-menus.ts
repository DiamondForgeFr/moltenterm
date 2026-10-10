// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How a panel's menus reach the command panel (FR-SHELL-047): a right-click on the header opens the panel at the
// pointer; a right-click in the body keeps a short menu (FR-SHELL-043) that ends with More… ⌘., which opens the panel
// where the menu was.

import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { fireAndForget } from "@/util/util";
import { acceleratorById } from "../shortcuts/format";
import { splitPanel } from "../split/split";
import { openCommandPanel, openCommandPanelAtPoint } from "./command-panel-store";

export const MoreLabel = "More…";

// Where the last context menu was asked for: More… opens the panel there, not under the header.
let lastMenuPoint: { x: number; y: number } = null;
let tracking = false;

export function trackContextMenuPoint() {
    if (tracking || typeof window === "undefined") {
        return;
    }
    tracking = true;
    window.addEventListener(
        "contextmenu",
        (e) => {
            lastMenuPoint = Number.isFinite(e.clientX) ? { x: e.clientX, y: e.clientY } : null;
        },
        true
    );
}

export function openHeaderCommandPanel(e: React.MouseEvent, blockId: string) {
    e.preventDefault();
    e.stopPropagation();
    openCommandPanelAtPoint(blockId, e.clientX, e.clientY, "header");
}

export function moreMenuItem(blockId: string): ContextMenuItem {
    const point = lastMenuPoint;
    return {
        label: MoreLabel,
        icon: "sliders",
        accelerator: acceleratorById("command-panel"),
        click: () => {
            if (point != null) {
                openCommandPanelAtPoint(blockId, point.x, point.y, "menu");
            } else {
                openCommandPanel(blockId, "menu");
            }
        },
    };
}

type MagnifyNode = { isMagnified: any; toggleMagnify: () => void };

// The body's short menu: the block actions and the way to everything else.
export function blockBodyMenuItems(blockId: string, nodeModel: MagnifyNode): ContextMenuItem[] {
    const magnified = nodeModel?.isMagnified != null && globalStore.get(nodeModel.isMagnified) === true;
    return [
        {
            label: "Split right",
            icon: "table-columns",
            accelerator: acceleratorById("split-right"),
            click: () => fireAndForget(() => splitPanel(blockId, "right")),
        },
        {
            label: "Split down",
            icon: "table-columns fa-rotate-270",
            accelerator: acceleratorById("split-down"),
            click: () => fireAndForget(() => splitPanel(blockId, "down")),
        },
        {
            label: magnified ? "Unmagnify" : "Magnify",
            icon: magnified ? "compress" : "expand",
            accelerator: acceleratorById("magnify"),
            click: () => nodeModel?.toggleMagnify(),
        },
        { type: "separator" },
        moreMenuItem(blockId),
        { type: "separator" },
        {
            label: "Close",
            icon: "xmark",
            destructive: true,
            accelerator: acceleratorById("close-panel"),
            click: () => uxCloseBlock(blockId),
        },
    ];
}

// A terminal's body menu keeps its own items (copy, paste, links) and ends with these instead of its settings.
export function terminalBodyMenuTail(blockId: string): ContextMenuItem[] {
    return [
        {
            label: "Split right",
            icon: "table-columns",
            accelerator: acceleratorById("split-right"),
            click: () => fireAndForget(() => splitPanel(blockId, "right")),
        },
        {
            label: "Split down",
            icon: "table-columns fa-rotate-270",
            accelerator: acceleratorById("split-down"),
            click: () => fireAndForget(() => splitPanel(blockId, "down")),
        },
        { type: "separator" },
        moreMenuItem(blockId),
    ];
}
