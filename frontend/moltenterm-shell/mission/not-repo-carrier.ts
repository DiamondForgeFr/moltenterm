// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One call to action per view in a folder without git (#1671, FR-SHELL-053, FR-REV-001 AC15): every git panel of a
// view showing the same folder registers here, and only the first in GitPanelOrder carries the explanation and the
// button; the others point to it. Integration comes first: its words say best why git is needed (branches and pull
// requests) and it names the view it sits in by default.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

export type GitPanel = "integration" | "project" | "cicd" | "linemap";

export const GitPanelOrder: GitPanel[] = ["integration", "project", "cicd", "linemap"];

// The panels' names as the view menus show them (WorkspaceViewPanels).
export const GitPanelNameKey: Record<GitPanel, string> = {
    integration: "workspaceViews.panels.integration",
    project: "workspaceViews.panels.project",
    cicd: "workspaceViews.panels.cicd",
    linemap: "workspaceViews.panels.lineMap",
};

// view and folder → block id → the panel showing the not-git state there
export type NotRepoPanels = Record<string, Record<string, GitPanel>>;

export const notRepoPanelsAtom = atom({}) as PrimitiveAtom<NotRepoPanels>;

export function notRepoGroupKey(tabId: string, dir: string): string {
    return JSON.stringify([tabId ?? "", dir ?? ""]);
}

// The block that carries the call to action: the first panel kind in GitPanelOrder, the smaller block id between two
// panels of the same kind (two Project panels in one view), so every panel of the group picks the same one.
export function notRepoCarrier(panels: Record<string, GitPanel>): { blockId: string; panel: GitPanel } {
    let best: { blockId: string; panel: GitPanel } = null;
    for (const [blockId, panel] of Object.entries(panels ?? {})) {
        const rank = GitPanelOrder.indexOf(panel);
        if (rank < 0) {
            continue;
        }
        if (best == null) {
            best = { blockId, panel };
            continue;
        }
        const bestRank = GitPanelOrder.indexOf(best.panel);
        if (rank < bestRank || (rank === bestRank && blockId < best.blockId)) {
            best = { blockId, panel };
        }
    }
    return best;
}

function setPanel(key: string, blockId: string, panel: GitPanel) {
    const all = globalStore.get(notRepoPanelsAtom);
    globalStore.set(notRepoPanelsAtom, { ...all, [key]: { ...(all[key] ?? {}), [blockId]: panel } });
}

function clearPanel(key: string, blockId: string) {
    const all = globalStore.get(notRepoPanelsAtom);
    const group = all[key];
    if (group == null || !(blockId in group)) {
        return;
    }
    const { [blockId]: _gone, ...rest } = group;
    const next = { ...all };
    if (Object.keys(rest).length === 0) {
        delete next[key];
    } else {
        next[key] = rest;
    }
    globalStore.set(notRepoPanelsAtom, next);
}

// Registers the panel while it shows the not-git state and answers which panel of its view carries the call to
// action: null when it is this one (or when it cannot be told apart from the others: no block id, outside a view).
export function useNotRepoCarrier(tabId: string, dir: string, blockId: string, panel: GitPanel): GitPanel {
    const key = notRepoGroupKey(tabId, dir);
    const groupAtom = useMemo(() => atom((get) => get(notRepoPanelsAtom)[key]), [key]);
    const group = useAtomValue(groupAtom, { store: globalStore });
    useEffect(() => {
        if (!blockId || !panel || !dir) {
            return;
        }
        setPanel(key, blockId, panel);
        return () => clearPanel(key, blockId);
    }, [key, blockId, panel, dir]);
    if (!blockId || !panel) {
        return null;
    }
    const carrier = notRepoCarrier(group);
    if (carrier == null || carrier.blockId === blockId) {
        return null;
    }
    return carrier.panel;
}
