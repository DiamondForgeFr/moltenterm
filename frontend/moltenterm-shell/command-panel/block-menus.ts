// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How a panel's menus reach the command panel (FR-SHELL-047): a right-click on the header opens the panel at the
// pointer; a right-click in the body keeps a short menu (FR-SHELL-043) that ends with More… ⌘., which opens the panel
// where the menu was.

import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { fireAndForget } from "@/util/util";
import { DeveloperSection } from "../menu/menu-model";
import { acceleratorById } from "../shortcuts/format";
import { PanelSection, splitMenuItems } from "../split/split-menu";
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

function magnifyMenuItem(nodeModel: MagnifyNode, section: string): ContextMenuItem {
    const magnified = nodeModel?.isMagnified != null && globalStore.get(nodeModel.isMagnified) === true;
    return {
        label: magnified ? "Unmagnify" : "Magnify",
        icon: magnified ? "compress" : "expand",
        section,
        accelerator: acceleratorById("magnify"),
        click: () => nodeModel?.toggleMagnify(),
    };
}

// Shown only while Option is held (FR-SHELL-054-AC2), like the command panel's Developer section.
export function panelDeveloperItems(blockId: string): ContextMenuItem[] {
    return [
        {
            label: "Copy panel id",
            icon: "hashtag",
            section: DeveloperSection,
            click: () => fireAndForget(() => navigator.clipboard.writeText(blockId)),
        },
    ];
}

// The body's short menu: the block actions and the way to everything else. The first group needs no heading; Close
// goes last, on its own (FR-SHELL-054).
export function blockBodyMenuItems(blockId: string, nodeModel: MagnifyNode): ContextMenuItem[] {
    return [
        ...splitMenuItems(blockId, ""),
        magnifyMenuItem(nodeModel, ""),
        { ...moreMenuItem(blockId), section: "" },
        ...panelDeveloperItems(blockId),
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

// A terminal's body menu keeps its own items (copy, paste, links) and ends with its Panel section instead of its
// settings.
export function terminalBodyMenuTail(blockId: string, nodeModel: MagnifyNode): ContextMenuItem[] {
    return [
        ...splitMenuItems(blockId, PanelSection),
        magnifyMenuItem(nodeModel, PanelSection),
        { ...moreMenuItem(blockId), section: PanelSection },
        ...panelDeveloperItems(blockId),
    ];
}
