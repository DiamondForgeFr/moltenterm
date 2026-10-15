// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a mod's code adds to the page, owned by the host (FR-MORPH-012, DS-MORPH-010). A mod is supported only through
// MoltenApi, but its code runs in the tab and can reach `document` (audit #713, probe P2: an injected <style> kept the
// accent green after the mod was disabled). The guard attributes to a mod every node its code adds directly to the
// page's roots (<html>, <head>, <body>) and removes them when the mod stops.
//
// Attribution reads the direct caller of the insertion from the stack: a MutationObserver's records arrive after the
// call and carry no caller, so they cannot tell a mod's node from the app's. Only the roots' own methods are wrapped,
// so the app pays nothing for its usual rendering. This is a reversibility aid, not a security boundary.

// The methods of a root that add children to it. insertAdjacent* with "beforebegin"/"afterend" add to the parent
// instead, which is itself a root for <head> and <body>: the guard watches the parent's children too.
export const MoltenPageInsertMethods = [
    "appendChild",
    "insertBefore",
    "replaceChild",
    "append",
    "prepend",
    "insertAdjacentElement",
    "insertAdjacentHTML",
] as const;

type AnyFunction = (...args: any[]) => any;

// The few parts of a DOM node the guard needs, so tests can run without a DOM.
export type MoltenPageNode = {
    childNodes: ArrayLike<any>;
    parentNode?: MoltenPageNode;
    removeChild?: (child: any) => any;
    [method: string]: any;
};

export type MoltenPageGuardOptions = {
    // The mod a script URL belongs to, or null (modIdForScript with the blob owners).
    ownerOfUrl: (url: string) => string;
    // Whether the mod runs now: nodes its leftover code adds once it stopped are removed at once.
    isLive: (modId: string) => boolean;
};

// The script URL of one line of a V8 stack ("    at fn (url:line:col)" or "    at url:line:col"), or null for a
// frame without a location ("at Array.forEach (<anonymous>)", "native").
export function stackFrameUrl(line: string): string {
    let loc = line.trim().replace(/^at\s+/, "");
    const open = loc.lastIndexOf("(");
    if (loc.endsWith(")") && open >= 0) {
        loc = loc.slice(open + 1, -1);
    }
    const m = /^(.*?):\d+:\d+$/.exec(loc);
    if (m == null || m[1] === "<anonymous>" || m[1] === "native") {
        return null;
    }
    return m[1];
}

// The mod that directly called `fn` (the wrapper of an insertion method): the first frame with a location below it.
// A mod's helper, callback or timer is its own frame; app code called by a mod (React flushing) is not.
export function callerModId(fn: AnyFunction, ownerOfUrl: (url: string) => string): string {
    const holder: { stack?: string } = {};
    const E = Error as any;
    if (typeof E.captureStackTrace !== "function") {
        return null;
    }
    const limit = E.stackTraceLimit;
    E.stackTraceLimit = 8;
    try {
        E.captureStackTrace(holder, fn);
    } finally {
        E.stackTraceLimit = limit;
    }
    const lines = (holder.stack ?? "").split("\n").slice(1);
    for (const line of lines) {
        const url = stackFrameUrl(line);
        if (url == null) {
            continue;
        }
        return ownerOfUrl(url);
    }
    return null;
}

export class MoltenPageGuard {
    opts: MoltenPageGuardOptions;
    roots: MoltenPageNode[] = [];
    // Mod id → the nodes its code added to a root, in order.
    owned = new Map<string, Set<any>>();
    // root → the original methods the guard wrapped, to restore them.
    originals = new Map<MoltenPageNode, Record<string, AnyFunction>>();

    constructor(opts: MoltenPageGuardOptions) {
        this.opts = opts;
    }

    // Wraps the insertion methods of each root. Calling it again for a root already guarded does nothing.
    install(roots: MoltenPageNode[]): void {
        for (const root of roots) {
            if (root == null || this.originals.has(root)) {
                continue;
            }
            this.roots.push(root);
            const saved: Record<string, AnyFunction> = {};
            for (const name of MoltenPageInsertMethods) {
                const original: AnyFunction = root[name];
                if (typeof original !== "function") {
                    continue;
                }
                saved[name] = original;
                const wrapper = (...args: any[]) => {
                    const owner = callerModId(wrapper, this.opts.ownerOfUrl);
                    if (owner == null) {
                        return original.apply(root, args);
                    }
                    return this.insertFor(owner, () => original.apply(root, args));
                };
                // An own property on this element only: the prototype, and so every other element, stays untouched.
                Object.defineProperty(root, name, { value: wrapper, configurable: true, writable: true });
            }
            this.originals.set(root, saved);
        }
    }

    uninstall(): void {
        for (const [root, saved] of this.originals) {
            for (const name of Object.keys(saved)) {
                delete root[name];
            }
        }
        this.originals.clear();
        this.roots = [];
    }

    insertFor(modId: string, insert: () => any): any {
        const before = this.roots.map((root) => new Set(Array.from(root.childNodes)));
        const result = insert();
        const added: any[] = [];
        this.roots.forEach((root, i) => {
            for (const child of Array.from(root.childNodes)) {
                if (!before[i].has(child)) {
                    added.push(child);
                }
            }
        });
        if (added.length === 0) {
            return result;
        }
        if (!this.opts.isLive(modId)) {
            console.warn(`[molten:${modId}] the mod is stopped: removed ${added.length} node(s) it added to the page`);
            added.forEach((node) => detach(node));
            return result;
        }
        let nodes = this.owned.get(modId);
        if (nodes == null) {
            nodes = new Set();
            this.owned.set(modId, nodes);
        }
        added.forEach((node) => nodes.add(node));
        return result;
    }

    // The nodes a mod added that are still attached, in a root or wherever the mod moved them since.
    nodesOf(modId: string): any[] {
        return [...(this.owned.get(modId) ?? [])].filter((node) => node?.parentNode != null);
    }

    // Removes what the mod added that is still in the page; returns how many nodes went.
    release(modId: string): number {
        const nodes = this.nodesOf(modId);
        this.owned.delete(modId);
        nodes.forEach((node) => detach(node));
        return nodes.length;
    }
}

function detach(node: any): void {
    const parent = node?.parentNode;
    if (parent == null) {
        return;
    }
    try {
        parent.removeChild(node);
    } catch (e) {
        console.error("[molten] a mod's node could not be removed from the page", e);
    }
}
