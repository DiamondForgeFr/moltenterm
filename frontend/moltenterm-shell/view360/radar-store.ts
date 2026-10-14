// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The radar's live inputs (FR-SHELL-068): the carpet columns' panels read from the layout tree, and per block its view,
// title, agent and attention, read from the stores the app already keeps (blocks, agent states, notifications).

import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { findNode } from "@/layout/lib/layoutNode";
import type { LayoutNode } from "@/layout/lib/types";
import { atom, Atom } from "jotai";
import { agentLabel } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { AgentStates } from "../agent-state-store";
import { MoltentermNotifications } from "../notifications-store";
import { PanelMeta, panelTitle } from "../tab-identity";
import { getHomeDir } from "../tab-identity-ui";
import type { CarpetLayout } from "./carpet-model";
import { attentionByBlock, RadarAttention, RadarBlockFacts, RadarColumnInput } from "./radar-model";

function leavesOf(node: LayoutNode, out: { nodeId: string; blockId: string }[]) {
    if (node == null) {
        return;
    }
    if (!node.children?.length) {
        if (node.data?.blockId) {
            out.push({ nodeId: node.id, blockId: node.data.blockId });
        }
        return;
    }
    for (const child of node.children) {
        leavesOf(child, out);
    }
}

export function radarColumns(rootNode: LayoutNode, layout: CarpetLayout): RadarColumnInput[] {
    if (rootNode == null || layout == null) {
        return [];
    }
    return layout.columns.map((column) => {
        const leaves: { nodeId: string; blockId: string }[] = [];
        leavesOf(findNode(rootNode, column.nodeId), leaves);
        return { columnId: column.nodeId, leaves };
    });
}

const attentionAtom: Atom<Record<string, RadarAttention>> = atom((get) =>
    attentionByBlock(
        get(AgentStates.getInstance().dataAtom).states,
        get(MoltentermNotifications.getInstance().shownEntriesAtom)
    )
);

function sameFacts(a: Record<string, RadarBlockFacts>, b: Record<string, RadarBlockFacts>): boolean {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) {
        return false;
    }
    return ka.every((k) => {
        const x = a[k];
        const y = b[k];
        return (
            y != null && x.view === y.view && x.agent === y.agent && x.title === y.title && x.attention === y.attention
        );
    });
}

// One atom per set of blocks; it hands back the same object while nothing the radar shows changed, so an agent's
// state updates (which come often while it works) do not render the radar again.
export function makeRadarFactsAtom(blockIds: string[]): Atom<Record<string, RadarBlockFacts>> {
    let last: Record<string, RadarBlockFacts> = {};
    return atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        const agents = get(AgentStates.getInstance().dataAtom).states;
        const attention = get(attentionAtom);
        const next: Record<string, RadarBlockFacts> = {};
        for (const blockId of blockIds) {
            const block = get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
            const meta = (block?.meta ?? {}) as PanelMeta & { "frame:title"?: string };
            const agent = agents[blockId];
            const title =
                (meta["frame:title"] ?? "").trim() ||
                (agent != null ? agentLabel(agent) : panelTitle(meta, getHomeDir()));
            next[blockId] = {
                view: meta.view ?? null,
                agent: agent != null,
                title,
                attention: attention[blockId] ?? null,
            };
        }
        if (sameFacts(last, next)) {
            return last;
        }
        last = next;
        return next;
    });
}
