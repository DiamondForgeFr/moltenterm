// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Making a view from a panel (FR-SHELL-080, #2548): the sequence, apart from what the app provides (panel-view-store.ts
// wires it), so that it is tested without the app. The view holds a copy of the panel, at the place chosen, and the
// panel stays where it is. A panel that holds an agent asks first: an agent cannot live in two places, and nothing moves
// before the answer.

import {
    AgentAnswer,
    agentPlan,
    asksBeforeMoving,
    noticeOf,
    PanelViewDestination,
    PanelViewNames,
} from "./panel-view-model";
import type { PinConfig, ViewState } from "./view-pins-model";

// The request of ViewPins.createView that a view made from a panel uses.
export type PanelViewRequest = {
    config: PinConfig;
    instanceConfig?: PinConfig;
    scope: ViewState;
    name: string;
    background: boolean;
    adopt?: { blockid: string; fromtabid: string };
    projectId?: string;
    beforePinId?: string;
};

export type PanelViewDeps = {
    sourceTabId: () => string;
    holds: (tabId: string, blockId: string) => boolean;
    isAgent: (blockId: string) => boolean;
    askAgent: () => Promise<AgentAnswer>;
    capture: (tabId: string, blockId: string, copy: boolean) => Promise<PinConfig>;
    blockName: (blockId: string) => string;
    names: () => PanelViewNames;
    createView: (req: PanelViewRequest) => Promise<string>;
    placeBefore: (tabId: string, beforeId: string) => Promise<void>;
    addToFolder: (folderId: string, tabId: string) => Promise<void>;
    notice: (text: string, tabId: string, phraseKey: string) => void;
    fresh: (...ids: string[]) => void;
    failed: (e: unknown) => void;
    translate: (key: string, vars?: Record<string, string>) => string;
};

export function scopeOf(dest: PanelViewDestination): ViewState {
    if (dest.kind === "pinned") {
        return "everywhere";
    }
    return dest.kind === "workspace" ? "workspace" : "temporary";
}

// Makes the view and says where it went. The panel is copied and stays where it is, except when it holds an agent and
// the answer is to move it: then the panel itself goes into the new view. A pin or a tile keeps what a pinned view
// keeps (it follows the project it opens on) while this workspace's view is the copy, as exact as the Views' own.
// Returns the new view's tab, or null when nothing was made (no such panel, a question left unanswered, a failure).
export async function createViewFromPanel(
    req: { blockId: string; destination: PanelViewDestination },
    deps: PanelViewDeps
): Promise<string> {
    const sourceTabId = deps.sourceTabId();
    const dest = req.destination;
    if (!req.blockId || !sourceTabId || dest == null || !deps.holds(sourceTabId, req.blockId)) {
        return null;
    }
    let plan = { move: false, make: true };
    if (asksBeforeMoving(deps.isAgent(req.blockId))) {
        plan = agentPlan(await deps.askAgent());
    }
    if (!plan.make) {
        return null;
    }
    try {
        const pinned = dest.kind !== "views";
        const config = await deps.capture(sourceTabId, req.blockId, !pinned);
        const instanceConfig = pinned ? await deps.capture(sourceTabId, req.blockId, true) : undefined;
        const name = deps.blockName(req.blockId);
        const tabId = await deps.createView({
            config,
            instanceConfig,
            scope: scopeOf(dest),
            name,
            background: true,
            adopt: plan.move ? { blockid: req.blockId, fromtabid: sourceTabId } : undefined,
            projectId: dest.kind === "views" ? dest.projectId : undefined,
            beforePinId: dest.kind === "pinned" ? dest.before : undefined,
        });
        if (!tabId) {
            return null;
        }
        if (dest.kind === "workspace") {
            await deps.placeBefore(tabId, dest.before);
        }
        if (dest.kind === "views") {
            if (dest.folderId != null) {
                await deps.addToFolder(dest.folderId, tabId);
            } else {
                await deps.placeBefore(tabId, dest.before);
            }
        }
        const phrase = noticeOf(dest, name, deps.names());
        deps.notice(deps.translate(phrase.key, phrase.vars), tabId, phrase.key);
        deps.fresh(tabId);
        return tabId;
    } catch (e) {
        deps.failed(e);
        return null;
    }
}
