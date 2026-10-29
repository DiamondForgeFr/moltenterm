// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The three states of a view (FR-SHELL-080): temporary, pinned in the workspace (a tile, its configuration kept in
// the tab), pinned everywhere (a block in every workspace's top row, one configuration kept in the client and opened
// by each workspace on its own project). A view is a tab and its layout. Kept apart from the components so the rules
// can be tested without the app; pkg/molten/viewpin reads and makes the configurations.

import { AgentStatesData, agentStatesOfBlocks } from "../agent-state-model";
import { StartPageUrl } from "../browser/browser-model";

// must match pkg/molten/viewpin/viewpin.go
export const ViewPinRoute = "molten:viewpin";
export const ViewPinCaptureCommand = "moltenviewpincapture";
export const ViewPinBuildCommand = "moltenviewpinbuild";
export const RepoToken = "molten:repo";
export const AgentSlotMetaKey = "molten:agentslot";
// The icon the developer chose for a view, in its tab's meta; a view pinned everywhere keeps it in its pin.
export const ViewIconMetaKey = "molten:viewicon";

// A tab pinned in its workspace: PinMetaKey says so, PinConfigMetaKey keeps its configuration.
export const PinMetaKey = "molten:pin";
export const PinWorkspace = "workspace";
export const PinConfigMetaKey = "molten:pinconfig";
// A workspace's own instance of a view pinned everywhere: the pin's id, and the version of the configuration it was
// made from.
export const GlobalPinMetaKey = "molten:globalpin";
export const GlobalPinRevMetaKey = "molten:pinrev";
// A temporary view made from a changed view pinned everywhere (#1272): the pin it came from, for Update the pinned
// view. Any move of the view clears it.
export const ForkedFromMetaKey = "molten:forkedfrom";
// The client's meta: the views pinned everywhere, in the top row's order.
export const GlobalPinsMetaKey = "molten:globalpins";

export type PinNode = { dir?: string; children?: PinNode[]; blockid?: string; pane?: number };

export type PinConfig = { tree: PinNode; panes: Record<string, any>[] };

// namekey: a seeded pin whose name the developer never chose (#1296, #1307); it shows the key's text in the interface
// language, name being the fallback. A rename drops it.
export type GlobalPin = { id: string; name: string; namekey?: string; icon?: string; rev: number; config: PinConfig };

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

// The top row's view that shows a panel (the app menu's View › Project, FR-SHELL-113): the one made of that panel
// alone first, as the default Project and Integration views are, else the first that holds it.
export function pinShowingPanel(pins: GlobalPin[], view: string): GlobalPin {
    const holding = (pins ?? []).filter((p) => (p?.config?.panes ?? []).some((pane) => pane?.view === view));
    return holding.find((p) => p.config.panes.length === 1) ?? holding[0] ?? null;
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

// must match ProjectTabMetaKey in frontend/moltenterm-shell/project/project-model.ts
export const ProjectTabMetaKey = "molten:projecttab";

export function isProjectTab(tab: { meta?: Record<string, any> }): boolean {
    return !!tab?.meta?.[ProjectTabMetaKey];
}

// The state the sidebar and the view menu name (#1244): MoltenTerm's own Project tab is a tile of its workspace
// (FR-SHELL-015), pinned there by MoltenTerm without a configuration of its own, and still closable, so its pin rules
// (viewStateOf) stay those of a temporary view while it reads as pinned in the workspace.
export function shownViewState(state: ViewState, projectTab: boolean): ViewState {
    return projectTab ? "workspace" : state;
}

// The states a view can move to from its menu or by drag (FR-SHELL-080, #1244): the two it is not in. The Project tab
// stays pinned in its workspace: each workspace has its own, on its own project, first in the strip (FR-SHELL-015), so
// pinning it everywhere would duplicate it in every workspace and making it temporary would contradict its place.
export function viewMoves(state: ViewState, projectTab?: boolean): ViewState[] {
    if (projectTab) {
        return [];
    }
    const all: ViewState[] = ["workspace", "everywhere", "temporary"];
    return all.filter((s) => s !== state);
}

// The pin keys of a tab's meta, as they are: what Undo writes back after a move.
export function pinMetaOf(meta: Record<string, any>): Record<string, any> {
    const rtn: Record<string, any> = {};
    for (const key of [...Object.keys(UnpinnedTabMeta), ViewIconMetaKey]) {
        rtn[key] = meta?.[key] ?? null;
    }
    return rtn;
}

// A move of a view between its states (FR-SHELL-080, #1244): the patch for its tab's meta, and the pins everywhere
// after it. Only the pin keys (and the icon a pin carried) change, so the tab, its panels, its layout, its name, its
// background and its sessions stay the view's own.
export type ViewMove = { tabMeta: Record<string, any>; pins: GlobalPin[]; pin?: GlobalPin };

export type ViewMoveInput = {
    // The tab's meta now (null for a top-row block this workspace never opened).
    tabMeta: Record<string, any>;
    pins: GlobalPin[];
    // The pin of a view pinned everywhere.
    pinId?: string;
    // The view's configuration as it shows now, for a pin from a temporary view or a tile.
    captured?: PinConfig;
    name?: string;
    newPinId?: string;
};

export function planViewMove(from: ViewState, to: ViewState, input: ViewMoveInput): ViewMove {
    if (from === to) {
        return null;
    }
    const meta = input.tabMeta ?? {};
    const pins = input.pins ?? [];
    const current = from === "everywhere" ? pins.find((p) => p.id === (input.pinId ?? meta[GlobalPinMetaKey])) : null;
    if (from === "everywhere" && current == null) {
        return null;
    }
    if (to === "everywhere") {
        if (input.captured == null || !input.newPinId) {
            return null;
        }
        const icon = meta[ViewIconMetaKey];
        const pin: GlobalPin = {
            id: input.newPinId,
            name: input.name ?? "",
            icon: typeof icon === "string" && icon.trim() !== "" ? icon.trim() : undefined,
            rev: 1,
            config: input.captured,
        };
        return {
            tabMeta: { ...UnpinnedTabMeta, [GlobalPinMetaKey]: pin.id, [GlobalPinRevMetaKey]: 1 },
            pins: [...pins, pin],
            pin,
        };
    }
    if (from === "everywhere") {
        const rest = withoutPin(pins, current.id);
        const icon = { [ViewIconMetaKey]: current.icon ?? null };
        if (to === "workspace") {
            return {
                tabMeta: {
                    ...UnpinnedTabMeta,
                    [PinMetaKey]: PinWorkspace,
                    [PinConfigMetaKey]: current.config,
                    ...icon,
                },
                pins: rest,
                pin: current,
            };
        }
        return { tabMeta: { ...UnpinnedTabMeta, ...icon }, pins: rest, pin: current };
    }
    if (to === "workspace") {
        if (input.captured == null) {
            return null;
        }
        return {
            tabMeta: { ...UnpinnedTabMeta, [PinMetaKey]: PinWorkspace, [PinConfigMetaKey]: input.captured },
            pins,
        };
    }
    return { tabMeta: { ...UnpinnedTabMeta }, pins };
}

// The pins everywhere once a move is undone: a pin the move removed goes back at its place, one it added leaves. Pins
// changed meanwhile (reordered, saved, renamed) keep those changes.
export function undoPins(before: GlobalPin[], now: GlobalPin[], moved: GlobalPin): GlobalPin[] {
    if (moved == null) {
        return now;
    }
    const wasThere = before.some((p) => p.id === moved.id);
    const rest = withoutPin(now, moved.id);
    if (!wasThere) {
        return rest;
    }
    const at = Math.min(
        before.findIndex((p) => p.id === moved.id),
        rest.length
    );
    return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

// A meta patch applied the way wavesrv applies SetMeta: a null value removes the key.
export function applyMetaPatch(meta: Record<string, any>, patch: Record<string, any>): Record<string, any> {
    const rtn = { ...(meta ?? {}) };
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value == null) {
            delete rtn[key];
        } else {
            rtn[key] = value;
        }
    }
    return rtn;
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
    // The start page stands for the repository page on a project without a GitHub remote (FR-SHELL-111).
    if (url.startsWith(RepoToken) || url === StartPageUrl) {
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

type PaneKeyFn = (meta: Record<string, any>) => string;

// What a panel is, for "did a view pinned everywhere change" (#1272): its kind only. Browsing to another site is
// content, as typing in a terminal is, and never makes a new view.
export function panelKind(meta: Record<string, any>): string {
    return meta?.view ?? "";
}

export function configSignature(config: PinConfig, keyOf: PaneKeyFn = paneKey): string {
    return signature(config?.tree, (leaf) => keyOf(config.panes[leaf.pane ?? -1]));
}

export function liveSignature(
    tree: PinNode,
    metaOf: (blockId: string) => Record<string, any>,
    keyOf: PaneKeyFn = paneKey
): string {
    return signature(tree, (leaf) => keyOf(metaOf(leaf.blockid)));
}

// A pinned view changed since it was pinned: its panels or their layout differ from its configuration. A layout not
// loaded yet is not a change.
export function viewModified(
    config: PinConfig,
    tree: PinNode,
    metaOf: (blockId: string) => Record<string, any>,
    keyOf: PaneKeyFn = paneKey
): boolean {
    if (config == null || tree == null) {
        return false;
    }
    if (treeBlockIds(tree).some((id) => metaOf(id) == null)) {
        return false;
    }
    return liveSignature(tree, metaOf, keyOf) !== configSignature(config, keyOf);
}

// An instance of a view pinned everywhere no longer has the pin's panels or layout (#1272): a panel added, closed,
// moved or split. Its content never counts.
export function viewForked(
    config: PinConfig,
    tree: PinNode,
    metaOf: (blockId: string) => Record<string, any>
): boolean {
    return viewModified(config, tree, metaOf, panelKind);
}

// When an instance of a view pinned everywhere leaves its pin (#1272).
export type ForkCheck = {
    state: ViewState;
    // Its panels or layout differ from the pin's (viewForked).
    changed: boolean;
    projectTab: boolean;
    // The view on screen: its toast shows where the developer looks; a view changed in the background forks when it
    // comes on screen.
    onScreen: boolean;
    // A drag runs (a panel, or a block of the sidebar): the layout is not final yet, and the drop may move the view.
    dragging: boolean;
    // Made from an older configuration (saved from another workspace): it compares against a layout it never had.
    stale: boolean;
};

export function forkDue(c: ForkCheck): boolean {
    if (c.state !== "everywhere" || !c.changed || c.projectTab) {
        return false;
    }
    return c.onScreen && !c.dragging && !c.stale;
}

// The layout has no actions left to apply: a rebuild from the configuration (opening a newer one, Back to the pinned
// state) is done, so its partial layouts never fork.
export function layoutSettled(layout: { pendingbackendactions?: any[] }): boolean {
    return (layout?.pendingbackendactions?.length ?? 0) === 0;
}

// The fork (#1272): only the tab's pin keys change, so the view keeps its tab, panels, sessions, agent and name, and
// remembers the pin it came from for Update the pinned view. The pin and the other workspaces are untouched.
export function planViewFork(pin: GlobalPin): Record<string, any> {
    return { ...UnpinnedTabMeta, [ViewIconMetaKey]: pin.icon ?? null, [ForkedFromMetaKey]: pin.id };
}

// The pin a temporary view came from, while that pin still exists.
export function forkOrigin(tab: { meta?: Record<string, any> }, pins: GlobalPin[]): GlobalPin {
    const id = tab?.meta?.[ForkedFromMetaKey];
    if (typeof id !== "string" || id === "") {
        return null;
    }
    const all = pins ?? [];
    if (viewStateOf(tab, new Set(all.map((p) => p.id))) !== "temporary") {
        return null;
    }
    return all.find((p) => p.id === id) ?? null;
}

// Update the pinned view (#1272): the pin takes the view's layout as a new revision, so every workspace's instance
// follows the next time it opens; the view becomes this workspace's instance again; another instance this workspace
// opened meanwhile becomes a temporary view rather than closing (nothing lost).
export type PinUpdate = {
    pins: GlobalPin[];
    pin: GlobalPin;
    tabMeta: Record<string, any>;
    othersMeta: Record<string, any>;
};

export function planPinUpdate(pins: GlobalPin[], pinId: string, captured: PinConfig): PinUpdate {
    const current = (pins ?? []).find((p) => p.id === pinId);
    if (current == null || captured == null) {
        return null;
    }
    const pin: GlobalPin = { ...current, rev: (current.rev ?? 0) + 1, config: captured };
    return {
        pins: replacePin(pins, pin),
        pin,
        tabMeta: { ...UnpinnedTabMeta, [GlobalPinMetaKey]: pin.id, [GlobalPinRevMetaKey]: pin.rev },
        othersMeta: { ...UnpinnedTabMeta, [ViewIconMetaKey]: current.icon ?? null },
    };
}

// Undo of Update the pinned view: the previous configuration comes back as a newer revision, so the instances made
// from the update follow back too. Other changes of the pin meanwhile (its name, its icon) stay.
export function undoPinUpdate(now: GlobalPin[], before: GlobalPin): GlobalPin[] {
    const current = (now ?? []).find((p) => p.id === before?.id);
    if (current == null) {
        return now;
    }
    return replacePin(now, { ...current, rev: (current.rev ?? 0) + 1, config: before.config });
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
    [ForkedFromMetaKey]: null,
};
