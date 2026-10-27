// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The three states of a view (FR-SHELL-080): temporary, pinned in the workspace (a tile, its configuration kept in
// the tab), pinned everywhere (a block in every workspace's top row, one configuration kept in the client and opened
// by each workspace on its own project). A view is a tab and its layout. Kept apart from the components so the rules
// can be tested without the app; pkg/molten/viewpin reads and makes the configurations.

import { AgentStatesData, agentStatesOfBlocks } from "../agent-state-model";

// must match pkg/molten/viewpin/viewpin.go
export const ViewPinRoute = "molten:viewpin";
export const ViewPinCaptureCommand = "moltenviewpincapture";
export const ViewPinBuildCommand = "moltenviewpinbuild";
export const RepoToken = "molten:repo";
export const AgentSlotMetaKey = "molten:agentslot";

// A tab pinned in its workspace: PinMetaKey says so, PinConfigMetaKey keeps its configuration.
export const PinMetaKey = "molten:pin";
export const PinWorkspace = "workspace";
export const PinConfigMetaKey = "molten:pinconfig";
// A workspace's own instance of a view pinned everywhere: the pin's id, and the version of the configuration it was
// made from.
export const GlobalPinMetaKey = "molten:globalpin";
export const GlobalPinRevMetaKey = "molten:pinrev";
// The client's meta: the views pinned everywhere, in the top row's order.
export const GlobalPinsMetaKey = "molten:globalpins";

export type PinNode = { dir?: string; children?: PinNode[]; blockid?: string; pane?: number };

export type PinConfig = { tree: PinNode; panes: Record<string, any>[] };

export type GlobalPin = { id: string; name: string; icon?: string; rev: number; config: PinConfig };

export type ViewState = "temporary" | "workspace" | "everywhere";

export type PinScope = "here" | "everywhere";

type LayoutNodeLike = {
    flexDirection?: string;
    children?: LayoutNodeLike[];
    data?: { blockId?: string };
};

function validConfig(value: any): value is PinConfig {
    return value != null && typeof value === "object" && value.tree != null && Array.isArray(value.panes);
}

export function readPinConfig(value: any): PinConfig {
    return validConfig(value) && value.panes.length > 0 ? value : null;
}

export function readGlobalPins(meta: Record<string, any>): GlobalPin[] {
    const raw = meta?.[GlobalPinsMetaKey];
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(
        (p) => p != null && typeof p.id === "string" && p.id !== "" && readPinConfig(p.config) != null
    ) as GlobalPin[];
}

export function makeGlobalPinId(now: number, random: number): string {
    return `g${now.toString(36)}${Math.floor(random * 1e6).toString(36)}`;
}

// The view's state from its tab: a tab whose pin everywhere is gone is temporary again.
export function viewStateOf(tab: { meta?: Record<string, any> }, globalIds: ReadonlySet<string>): ViewState {
    const gid = tab?.meta?.[GlobalPinMetaKey];
    if (typeof gid === "string" && globalIds.has(gid)) {
        return "everywhere";
    }
    if (tab?.meta?.[PinMetaKey] === PinWorkspace && readPinConfig(tab.meta[PinConfigMetaKey]) != null) {
        return "workspace";
    }
    return "temporary";
}

// The layout as the window holds it, in the shape a configuration keeps: splits and panels, without sizes or ids; a
// split of one is its child.
export function layoutTree(node: LayoutNodeLike): PinNode {
    if (node == null) {
        return null;
    }
    const children = (node.children ?? []).map(layoutTree).filter((c) => c != null);
    if (children.length === 0) {
        const blockid = node.data?.blockId;
        return blockid ? { blockid } : null;
    }
    if (children.length === 1) {
        return children[0];
    }
    return { dir: node.flexDirection === "column" ? "column" : "row", children };
}

export function treeBlockIds(node: PinNode): string[] {
    if (node == null) {
        return [];
    }
    if (node.children?.length) {
        return node.children.flatMap(treeBlockIds);
    }
    return node.blockid ? [node.blockid] : [];
}

function hostOf(url: string): string {
    if (typeof url !== "string" || url === "") {
        return "";
    }
    if (url.startsWith(RepoToken)) {
        return "github.com";
    }
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// What a panel is, for "did the view change": its kind, and the site of a page. A page browsing its site, a terminal
// changing folder or an agent starting in its slot leave the view as pinned.
export function paneKey(meta: Record<string, any>): string {
    const view = meta?.view ?? "";
    if (view === "molten-browser" || view === "web") {
        return `${view}:${hostOf(meta.url)}`;
    }
    return view;
}

function signature(node: PinNode, keyOf: (leaf: PinNode) => string): string {
    if (node == null) {
        return "";
    }
    if (node.children?.length) {
        return `${node.dir === "column" ? "C" : "R"}(${node.children.map((c) => signature(c, keyOf)).join(",")})`;
    }
    return keyOf(node);
}

export function configSignature(config: PinConfig): string {
    return signature(config?.tree, (leaf) => paneKey(config.panes[leaf.pane ?? -1]));
}

export function liveSignature(tree: PinNode, metaOf: (blockId: string) => Record<string, any>): string {
    return signature(tree, (leaf) => paneKey(metaOf(leaf.blockid)));
}

// A pinned view changed since it was pinned: its panels or their layout differ from its configuration. A layout not
// loaded yet is not a change.
export function viewModified(
    config: PinConfig,
    tree: PinNode,
    metaOf: (blockId: string) => Record<string, any>
): boolean {
    if (config == null || tree == null) {
        return false;
    }
    if (treeBlockIds(tree).some((id) => metaOf(id) == null)) {
        return false;
    }
    return liveSignature(tree, metaOf) !== configSignature(config);
}

// A finished view: an agent is in it and none works, waits or reports an error. A done agent the developer has seen
// turns idle, so idle counts as finished too. A view without an agent is not finished.
export function viewFinished(data: AgentStatesData, blockIds: string[]): boolean {
    const states = agentStatesOfBlocks(data, blockIds ?? []);
    return states.length > 0 && states.every((s) => s.state === "done" || s.state === "idle");
}

// An agent works or waits in the view: opening the pin's newer configuration would take its panel away.
export function viewBusy(data: AgentStatesData, blockIds: string[]): boolean {
    return agentStatesOfBlocks(data, blockIds ?? []).some((s) => s.state === "working" || s.state === "waiting");
}

// The panels that hold an agent, which a configuration keeps as agent slots.
export function agentBlocksOf(data: AgentStatesData, blockIds: string[]): string[] {
    return (blockIds ?? []).filter((id) => data?.states?.[id] != null);
}

// The workspace's instance of a pin needs the newer configuration (saved from another workspace) when it was made
// from an older one.
export function instanceStale(tab: { meta?: Record<string, any> }, pin: GlobalPin): boolean {
    const rev = tab?.meta?.[GlobalPinRevMetaKey];
    return typeof rev !== "number" || rev < (pin?.rev ?? 0);
}

export function withoutPin(pins: GlobalPin[], id: string): GlobalPin[] {
    return pins.filter((p) => p.id !== id);
}

export function replacePin(pins: GlobalPin[], pin: GlobalPin): GlobalPin[] {
    return pins.map((p) => (p.id === pin.id ? pin : p));
}

// The tab meta that makes a view temporary again, whatever it was.
export const UnpinnedTabMeta: Record<string, any> = {
    [PinMetaKey]: null,
    [PinConfigMetaKey]: null,
    [GlobalPinMetaKey]: null,
    [GlobalPinRevMetaKey]: null,
};
