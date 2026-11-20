// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the remembered layout of the view on screen up to date (FR-SHELL-082, #2407): whenever its panels change (a
// split, a resize, a panel opened or closed, the window resized), once they have settled, the view writes where they
// are. Only the view on screen writes, and never during a switch: its frames or its content fading are no layout.

import { atoms, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { useEffect } from "react";
import { arriving, contentElement, leaving, switchLayoutOn } from "./layout-frames";
import {
    LayoutKeyPrefix,
    MeasuredBlock,
    measureLayout,
    readLayout,
    RememberedLayout,
    sameLayout,
    staleLayoutKeys,
    writeLayout,
} from "./layout-memory";

// The layout animates its changes (about 100 ms): it is read once it has been still this long.
export const LayoutSettleMs = 400;

function blockKind(id: string): string {
    const block = WOS.getObjectValue<Block>(WOS.makeORef("block", id));
    return (block?.meta as Record<string, any>)?.view ?? "";
}

// The panels on screen, in the page's order: a panel inside another one (a preview's own blocks) is the outer one's.
export function measureBlocks(content: Element, kind: (id: string) => string = blockKind): MeasuredBlock[] {
    const out: MeasuredBlock[] = [];
    const blocks = Array.from(content.querySelectorAll<HTMLElement>(".block[data-blockid]"));
    for (const el of blocks) {
        if (el.parentElement?.closest(".block[data-blockid]") != null) {
            continue;
        }
        const r = el.getBoundingClientRect();
        const id = el.dataset.blockid;
        out.push({ id, kind: kind(id), rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    }
    return out;
}

export function recordLayoutNow(workspaceId: string, tabId: string, last: RememberedLayout): RememberedLayout {
    if (document.visibilityState !== "visible" || leaving() || arriving()) {
        return last;
    }
    const content = contentElement();
    if (content == null) {
        return last;
    }
    const r = content.getBoundingClientRect();
    const layout = measureLayout(
        workspaceId,
        tabId,
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        measureBlocks(content),
        Date.now()
    );
    if (layout == null || layout.panels.length === 0 || sameLayout(layout, last)) {
        return last;
    }
    writeLayout(layout);
    return layout;
}

export function pruneLayouts(workspaceIds: readonly string[]) {
    try {
        const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(LayoutKeyPrefix));
        for (const key of staleLayoutKeys(keys, workspaceIds)) {
            window.localStorage.removeItem(key);
        }
    } catch {
        // Nothing to prune without storage.
    }
}

export function useRememberLayout(workspaceId: string, tabId: string) {
    useEffect(() => {
        if (!workspaceId || !tabId || !switchLayoutOn()) {
            return;
        }
        let last = readLayout(workspaceId);
        let timer: ReturnType<typeof setTimeout> = null;
        const record = () => {
            timer = null;
            last = recordLayoutNow(workspaceId, tabId, last);
        };
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(record, LayoutSettleMs);
        };
        const model = getLayoutModelForStaticTab();
        const unsubs: (() => void)[] = [];
        if (model != null && globalStore.get(atoms.staticTabId) === tabId) {
            unsubs.push(globalStore.sub(model.additionalProps, schedule));
            unsubs.push(globalStore.sub(model.leafs, schedule));
        }
        window.addEventListener("resize", schedule);
        document.addEventListener("visibilitychange", schedule);
        schedule();
        return () => {
            clearTimeout(timer);
            unsubs.forEach((u) => u());
            window.removeEventListener("resize", schedule);
            document.removeEventListener("visibilitychange", schedule);
        };
    }, [workspaceId, tabId]);
}
