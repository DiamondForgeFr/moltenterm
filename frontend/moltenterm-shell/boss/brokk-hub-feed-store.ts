// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the window feeds Brokk's hub with (FR-BOSS-009, AC5, AC8, AC11, AC14, #2002): the rows To handle, the agent states,
// the settings, and what happens in the sidebar (the search field, a drag, the sidebar being on screen) and around it
// (his panel opening or closing). One subscription per source, each telling the hub only when its value changed. The
// sources are handed in, so the wiring is tested against a store of its own; brokk-hub-store.ts hands in the window's.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { Atom, createStore } from "jotai";
import type { AgentStatesData } from "../agent-state-model";
import type { ToHandleList } from "./boss-to-handle-model";
import type { BrokkHub } from "./brokk-hub";
import type { VisitSettings } from "./brokk-visit-events";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

export type HubSources = {
    store: Store;
    agentsAtom: Atom<AgentStatesData>;
    agentsLoadedAtom: Atom<boolean>;
    toHandleAtom: Atom<ToHandleList>;
    settingsAtom: Atom<VisitSettings>;
    // The sidebar is on screen: docked, or floating over the content. Hidden, there is no scene to stand on.
    sidebarOnScreenAtom: Atom<boolean>;
    // The top field (the search field) is open: it holds the focus.
    searchOpenAtom: Atom<boolean>;
    // A view, a tile or a block is being dragged in the sidebar.
    dragAtom: Atom<boolean>;
    // His panel (the Sessions card until the panel story) is open.
    cardOpenAtom: Atom<boolean>;
};

// Reads `atom` now and at every change, and calls `tell` with the new value each time it differs from the last. The
// first reading is told only when `tellFirst` says so: a drag that ends is a gesture, one that never began is not.
function follow<T>(
    store: Store,
    atom: Atom<T>,
    tell: (value: T) => void,
    tellFirst: (value: T) => boolean = () => true
): () => void {
    let last = store.get(atom);
    if (tellFirst(last)) {
        tell(last);
    }
    return store.sub(atom, () => {
        const next = store.get(atom);
        if (next !== last) {
            last = next;
            tell(next);
        }
    });
}

export function feedBrokkHub(hub: BrokkHub, src: HubSources): () => void {
    const { store } = src;
    const readings = () => {
        if (!store.get(src.agentsLoadedAtom)) {
            return;
        }
        hub.agents(store.get(src.agentsAtom));
        hub.syncRows(store.get(src.toHandleAtom).items);
    };
    const stops = [
        follow(store, src.settingsAtom, (settings) => hub.settings(settings)),
        follow(store, src.sidebarOnScreenAtom, (onScreen) => hub.gate({ type: "hidden", hidden: !onScreen })),
        follow(store, src.searchOpenAtom, (focused) => hub.gate({ type: "search", focused })),
        follow(
            store,
            src.dragAtom,
            (dragging) => hub.gate({ type: dragging ? "dragstart" : "dragend" }),
            (dragging) => dragging
        ),
        follow(
            store,
            src.cardOpenAtom,
            (open) => (open ? hub.panelOpened() : hub.wake()),
            (open) => open
        ),
        store.sub(src.agentsAtom, readings),
        store.sub(src.agentsLoadedAtom, readings),
        store.sub(src.toHandleAtom, readings),
    ];
    readings();
    return () => stops.forEach((stop) => stop());
}
