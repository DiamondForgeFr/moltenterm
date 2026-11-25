// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The places a bookmark can be at, as the popover's place finder and the column panel read them (FR-BRW-019, #2531): the
// app, its contexts, their workspaces and the projects of each. Pure: the components feed it the contexts and the
// workspaces they know and show what it answers. It never creates a place: contexts, workspaces and projects are made
// elsewhere, never from the bookmarks.

import type { ContextInfo } from "../contexts/context-model";
import {
    Here,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    PlaceRef,
    placeKey,
    projectPlaceId,
    refsHere,
    sameRef,
} from "./bookmarks";

// What a workspace gives the catalog; its projects in order.
export type CatalogWorkspace = {
    id: string;
    name: string;
    color: string;
    contextId: string;
    projects: { id: string; name: string }[];
};

export type PlaceNode = {
    ref: PlaceRef;
    key: string;
    name: string;
    // The key of the node it belongs to; "" for the app.
    parent: string;
    // The keys of the nodes under it: the contexts under the app, a context's workspaces, a workspace's projects.
    children: string[];
    // A workspace's colour (the place colour); "" for the others.
    color: string;
};

export type PlaceCatalog = { app: PlaceNode; nodes: Map<string, PlaceNode> };

export function buildCatalog(input: {
    appName: string;
    contexts: readonly { context: ContextInfo; name: string }[];
    workspaces: readonly CatalogWorkspace[];
}): PlaceCatalog {
    const nodes = new Map<string, PlaceNode>();
    const make = (ref: PlaceRef, name: string, parent: PlaceNode, color = ""): PlaceNode => {
        const node: PlaceNode = { ref, key: placeKey(ref), name, parent: parent?.key ?? "", children: [], color };
        nodes.set(node.key, node);
        parent?.children.push(node.key);
        return node;
    };
    const app = make({ level: LevelApp, id: "" }, input.appName, null);
    for (const { context, name } of input.contexts) {
        const contextNode = make({ level: LevelContext, id: context.id }, name, app);
        for (const ws of input.workspaces.filter((w) => w.contextId === context.id)) {
            const workspaceNode = make({ level: LevelWorkspace, id: ws.id }, ws.name, contextNode, ws.color);
            for (const project of ws.projects) {
                make({ level: LevelProject, id: projectPlaceId(ws.id, project.id) }, project.name, workspaceNode);
            }
        }
    }
    return { app, nodes };
}

export function nodeOf(catalog: PlaceCatalog, ref: PlaceRef): PlaceNode {
    return catalog.nodes.get(placeKey(ref)) ?? null;
}

// The nodes from the app down to the node itself.
export function chainOf(catalog: PlaceCatalog, ref: PlaceRef): PlaceNode[] {
    const chain: PlaceNode[] = [];
    let node = nodeOf(catalog, ref);
    while (node != null) {
        chain.unshift(node);
        node = node.parent === "" ? null : (catalog.nodes.get(node.parent) ?? null);
    }
    return chain;
}

// The names above a node, from the app down: the path under a result.
export function pathOf(catalog: PlaceCatalog, ref: PlaceRef): string[] {
    return chainOf(catalog, ref)
        .slice(0, -1)
        .map((n) => n.name);
}

export function childrenOf(catalog: PlaceCatalog, node: PlaceNode): PlaceNode[] {
    return node.children.map((key) => catalog.nodes.get(key)).filter((n) => n != null);
}

// The chain of the place where the developer stands: the deepest place of here that the catalog knows.
export function hereNode(catalog: PlaceCatalog, here: Here): PlaceNode {
    const refs = refsHere(here);
    for (let i = refs.length - 1; i >= 0; i--) {
        const node = nodeOf(catalog, refs[i]);
        if (node != null) {
            return node;
        }
    }
    return catalog.app;
}

// Lower-cased and without accents, one output character (code point) per input character, so that a match's positions
// point into the original text read by code points (Array.from).
function folded(value: string): string[] {
    return Array.from(value, (ch) => {
        const base = ch
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase();
        return Array.from(base)[0] ?? ch;
    });
}

function indexOfRun(target: string[], query: string[]): number {
    for (let i = 0; i + query.length <= target.length; i++) {
        if (query.every((ch, j) => target[i + j] === ch)) {
            return i;
        }
    }
    return -1;
}

export type PlaceMatch = { node: PlaceNode; positions: number[]; score: number };

// A run of the typed letters inside the name, ignoring case and accents: the best match, better still at the start of a
// word. null when the typed text is not in the name as it stands.
export function matchRun(name: string, typed: string): { positions: number[]; score: number } {
    const query = folded(typed.trim());
    if (query.length === 0) {
        return { positions: [], score: 0 };
    }
    const target = folded(name);
    const at = indexOfRun(target, query);
    if (at < 0) {
        return null;
    }
    const wordStart = at === 0 || /[\s\-_/·›.]/.test(target[at - 1]);
    return {
        positions: Array.from({ length: query.length }, (_, i) => at + i),
        score: 200 - at + (wordStart ? 40 : 0) - (target.length - query.length) / 100,
    };
}

// How a name matches what was typed: a run of the typed letters scores best, the letters in order but apart come next;
// positions are the letters to underline.
export function matchName(name: string, typed: string): { positions: number[]; score: number } {
    const run = matchRun(name, typed);
    if (run != null) {
        return run;
    }
    const query = folded(typed.trim());
    const target = folded(name);
    const positions: number[] = [];
    let from = 0;
    for (const ch of query) {
        const found = target.indexOf(ch, from);
        if (found < 0) {
            return null;
        }
        positions.push(found);
        from = found + 1;
    }
    const spread = positions[positions.length - 1] - positions[0] - (positions.length - 1);
    return { positions, score: 100 - spread };
}

const KindRank: Record<string, number> = { [LevelContext]: 0, [LevelWorkspace]: 1, [LevelProject]: 2 };

// The places a typed text finds, best first: every context, workspace and project (never the app, which the places of
// here already offer). A place whose own name does not match but whose path does comes after, with nothing underlined.
export function searchPlaces(catalog: PlaceCatalog, typed: string, limit = 30): PlaceMatch[] {
    const found: PlaceMatch[] = [];
    for (const node of catalog.nodes.values()) {
        if (node.ref.level === LevelApp) {
            continue;
        }
        const own = matchName(node.name, typed);
        if (own != null) {
            found.push({ node, positions: own.positions, score: own.score });
            continue;
        }
        const path = pathOf(catalog, node.ref).join(" ");
        if (matchName(path, typed) != null) {
            found.push({ node, positions: [], score: 10 });
        }
    }
    found.sort(
        (a, b) =>
            b.score - a.score ||
            KindRank[a.node.ref.level] - KindRank[b.node.ref.level] ||
            a.node.name.localeCompare(b.node.name)
    );
    return found.slice(0, limit);
}

// "Near here": the other projects of the workspace, then the context's other workspaces and their projects.
export function nearHere(catalog: PlaceCatalog, here: Here, limit = 12): PlaceNode[] {
    const refs = refsHere(here);
    const own = (node: PlaceNode) => refs.some((r) => sameRef(r, node.ref));
    const out: PlaceNode[] = [];
    const workspace = nodeOf(catalog, { level: LevelWorkspace, id: here.workspaceId });
    const context = nodeOf(catalog, { level: LevelContext, id: here.contextId });
    if (workspace != null) {
        out.push(...childrenOf(catalog, workspace).filter((n) => !own(n)));
    }
    for (const sibling of context == null ? [] : childrenOf(catalog, context)) {
        if (own(sibling)) {
            continue;
        }
        out.push(sibling, ...childrenOf(catalog, sibling));
    }
    return out.slice(0, limit);
}

const RecentKey = "molten:bookmarks:recent";
const RecentMax = 6;

// The places last used, newest first: a convenience of this window, kept in its browser storage, which may be absent.
export function readRecentKeys(): string[] {
    try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(RecentKey) ?? "[]");
        return Array.isArray(raw) ? raw.filter((k) => typeof k === "string").slice(0, RecentMax) : [];
    } catch {
        return [];
    }
}

export function noteRecentPlace(ref: PlaceRef): void {
    try {
        const key = placeKey(ref);
        const next = [key, ...readRecentKeys().filter((k) => k !== key)].slice(0, RecentMax);
        globalThis.localStorage?.setItem(RecentKey, JSON.stringify(next));
    } catch (e) {
        console.log("bookmarks: recent places not kept", e);
    }
}

export function recentNodes(catalog: PlaceCatalog, keys: readonly string[]): PlaceNode[] {
    return keys.map((k) => catalog.nodes.get(k)).filter((n) => n != null && n.ref.level !== LevelApp);
}
