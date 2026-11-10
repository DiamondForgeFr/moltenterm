// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's filter, kept per view (FR-REV-034 AC9): the tab's meta holds the agents the view follows and
// those the developer ignored. It is written once, when the panel first opens in the view (the agents there then), and
// after that only by the developer's clicks: an agent joining or leaving the view changes nothing by itself.

import { atoms, getTabMetaKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { AgentChain } from "../agent-chain-store";
import { AgentStates } from "../agent-state-store";
import {
    initialScope,
    OwnerScope,
    presentAgentNames,
    proposals,
    readScope,
    scopeAdd,
    scopeIgnore,
    ScopeMetaKey,
    ScopeNames,
    scopeNames,
    scopeOnly,
    scopeRemove,
} from "./reviews-owners-model";

// A value written by this page, shown until the tab's meta changes from what it was then: the meta then holds this
// write, or a newer one from another page. A write that fails keeps it for this page.
type Pending = { value: OwnerScope; base: string };

function stamp(v: unknown): string {
    return JSON.stringify(v ?? null);
}

export class ViewScope {
    private static instance: ViewScope = null;

    pendingAtom = atom({}) as PrimitiveAtom<Record<string, Pending>>;
    atomsByTab = new Map<string, Atom<OwnerScope>>();
    fresh = new Set<string>();

    private constructor() {}

    static getInstance(): ViewScope {
        if (ViewScope.instance == null) {
            ViewScope.instance = new ViewScope();
        }
        return ViewScope.instance;
    }

    static resetInstance(): void {
        ViewScope.instance = null;
    }

    metaAtom(tabId: string): Atom<unknown> {
        return getTabMetaKeyAtom(tabId, ScopeMetaKey as keyof MetaType);
    }

    // The view's filter; null while the panel never opened in it.
    scopeAtom(tabId: string): Atom<OwnerScope> {
        let rtn = this.atomsByTab.get(tabId);
        if (rtn == null) {
            const saved = this.metaAtom(tabId);
            rtn = atom((get) => {
                const meta = get(saved);
                const pending = get(this.pendingAtom)[tabId];
                if (pending != null && pending.base === stamp(meta)) {
                    return pending.value;
                }
                return readScope(meta);
            });
            this.atomsByTab.set(tabId, rtn);
        }
        return rtn;
    }

    write(tabId: string, scope: OwnerScope): void {
        if (!tabId) {
            return;
        }
        const base = stamp(globalStore.get(this.metaAtom(tabId)));
        globalStore.set(this.pendingAtom, { ...globalStore.get(this.pendingAtom), [tabId]: { value: scope, base } });
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("tab", tabId),
            meta: { [ScopeMetaKey]: scope } as MetaType,
        }).catch((e) => console.log("reviews: could not keep the view's filter", e));
    }

    // Opens the view's filter on the agents already there, once: a view that holds one keeps it.
    ensure(tabId: string, present: readonly string[]): void {
        if (!tabId || globalStore.get(this.scopeAtom(tabId)) != null) {
            return;
        }
        this.write(tabId, initialScope(present));
        if (present.length > 0) {
            this.fresh.add(tabId);
        }
    }

    // The panel just opened its filter on agents in this view: true once, for the page that asks first (it then selects
    // the project chip of those agents, FR-REV-034).
    takeFresh(tabId: string): boolean {
        return this.fresh.delete(tabId);
    }
}

export type ViewScopeState = {
    tabId: string;
    scope: OwnerScope;
    names: ScopeNames;
    // The agents in the view now, and those among them the filter does not cover and nobody ignored.
    present: string[];
    proposed: string[];
    add: (name: string) => void;
    ignore: (name: string) => void;
    remove: (names: string[]) => void;
    only: (name: string) => void;
    showAll: () => void;
};

const NoAgents: string[] = [];

// The panel's filter for the view it sits in. Until the first agent states arrive nothing is written: the agents of the
// view are not known yet, and the filter would open on none.
export function useViewScope(): ViewScopeState {
    const tabId = useAtomValue(atoms.staticTabId);
    const store = ViewScope.getInstance();
    const saved = useAtomValue(store.scopeAtom(tabId ?? ""));
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const loaded = useAtomValue(AgentStates.getInstance().loadedAtom);
    const edges = useAtomValue(AgentChain.getInstance().edgesAtom);
    const present = useMemo(() => (tabId ? presentAgentNames(states, tabId) : NoAgents), [states, tabId]);
    useEffect(() => {
        if (loaded) {
            store.ensure(tabId, present);
        }
    }, [loaded, tabId, present, store]);
    const scope = useMemo(() => saved ?? initialScope(loaded ? present : []), [saved, loaded, present]);
    const names = useMemo(() => scopeNames(scope, edges), [scope, edges]);
    const proposed = useMemo(
        () => (saved == null ? NoAgents : proposals(present, scope, edges)),
        [saved, present, scope, edges]
    );
    const write = useCallback((next: OwnerScope) => store.write(tabId, next), [store, tabId]);
    return {
        tabId,
        scope,
        names,
        present,
        proposed,
        add: (name) => write(scopeAdd(scope, name)),
        ignore: (name) => write(scopeIgnore(scope, name)),
        remove: (list) => write(scopeRemove(scope, list, present)),
        only: (name) => write(scopeOnly(scope, name)),
        showAll: () => write(scopeRemove(scope, scope.agents, present)),
    };
}
