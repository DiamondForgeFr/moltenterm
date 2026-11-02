// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reads what is on screen for the shortcut overlay (FR-SHELL-090): the controls that declare a shortcut and are
// visible, the focused panel, the panel under the pointer, the sidebar and the 360 view.

import { getBlockComponentModel } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { isMacOS } from "@/util/platformutil";
import { SidebarModel } from "../sidebar/sidebar-store";
import {
    OverlayAnchor,
    OverlayPanel,
    OverlayRect,
    OverlayScreen,
    ShortcutAttr,
    ShortcutDigitAttr,
} from "./overlay-model";

const PanelSelector = ".block-frame-default[data-blockid]";

function toRect(r: DOMRect): OverlayRect {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// Drawn, inside the window and not hidden by an ancestor (a closed popover, a collapsed sidebar).
function isOnScreen(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
        return false;
    }
    if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) {
        return false;
    }
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
    }
    // The element is not covered by a dialog: its centre hits it or one of its children.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit == null || el.contains(hit) || hit.closest(`[${ShortcutAttr}]`) === el;
}

export function readAnchors(root: ParentNode = document): OverlayAnchor[] {
    const rtn: OverlayAnchor[] = [];
    for (const el of root.querySelectorAll(`[${ShortcutAttr}]`)) {
        if (!isOnScreen(el)) {
            continue;
        }
        const n = Number(el.getAttribute(ShortcutDigitAttr));
        rtn.push({
            id: el.getAttribute(ShortcutAttr),
            n: Number.isInteger(n) && n > 0 ? n : undefined,
            rect: toRect(el.getBoundingClientRect()),
        });
    }
    return rtn;
}

function panelOf(el: Element, leafNums: Map<string, number>): OverlayPanel {
    const frame = el?.closest(PanelSelector);
    if (frame == null) {
        return null;
    }
    const blockId = frame.getAttribute("data-blockid");
    const view = getBlockComponentModel(blockId)?.viewModel?.viewType ?? "";
    return { blockId, view, rect: toRect(frame.getBoundingClientRect()), num: leafNums.get(blockId) };
}

function hoveredElement(): Element {
    const hovered = document.querySelectorAll(":hover");
    return hovered.length ? hovered[hovered.length - 1] : null;
}

export function readScreen(): OverlayScreen {
    const layoutModel = getLayoutModelForStaticTab();
    const leafNums = new Map<string, number>();
    let focused: OverlayPanel = null;
    let view360 = false;
    if (layoutModel != null) {
        const leafOrder = globalStore.get(layoutModel.leafOrder) ?? [];
        leafOrder.forEach((leaf, i) => leafNums.set(leaf.blockid, i + 1));
        const focusedBlockId = globalStore.get(layoutModel.focusedNode)?.data?.blockId;
        if (focusedBlockId != null) {
            const frame = document.querySelector(`${PanelSelector}[data-blockid="${CSS.escape(focusedBlockId)}"]`);
            focused = frame != null && isOnScreen(frame) ? panelOf(frame, leafNums) : null;
        }
        view360 = layoutModel.moltenView360?.active ?? false;
    }
    const sidebar = SidebarModel.getInstance();
    return {
        mac: isMacOS(),
        sidebarEnabled: sidebar.isEnabled(),
        sidebarHidden: sidebar.isHidden(),
        view360,
        focused,
        hovered: panelOf(hoveredElement(), leafNums),
        anchors: readAnchors(),
    };
}
