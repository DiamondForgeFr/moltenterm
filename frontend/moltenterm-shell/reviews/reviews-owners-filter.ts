// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's owners filter as the panel's header will carry it (FR-REV-034 AC12, #2207): what there is to
// show of it, derived from the view's agents and filter. One OwnersFilter per panel.

import { atoms } from "@/app/store/global";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { AgentStates } from "../agent-state-store";
import {
    effectiveScope,
    NoOwnersFilter,
    ownersFilterFacts,
    OwnersFilterFacts,
    presentAgentNames,
    sameOwnersFilterFacts,
} from "./reviews-owners-model";
import { ViewScope } from "./reviews-owners-store";

// Where the open menu hangs: the lower right corner of the button it belongs to.
export type OwnersMenuAnchor = { right: number; bottom: number };

export class OwnersFilter {
    // How many lists the filter applies to are on screen: the project's list, or the list of all projects. The filter
    // shows only while one is.
    listsAtom = atom(0) as PrimitiveAtom<number>;
    menuAtom = atom(null) as PrimitiveAtom<OwnersMenuAnchor>;
    factsAtom: Atom<OwnersFilterFacts>;

    constructor() {
        const states = AgentStates.getInstance();
        // Compared by value: the agent states change all the time and the header must not redraw for it.
        this.factsAtom = selectAtom<OwnersFilterFacts, OwnersFilterFacts>(
            atom((get) => {
                const tabId = get(atoms.staticTabId) ?? "";
                if (!tabId) {
                    return NoOwnersFilter;
                }
                const present = presentAgentNames(get(states.dataAtom), tabId);
                const saved = get(ViewScope.getInstance().scopeAtom(tabId));
                const scope = effectiveScope(saved, get(states.loadedAtom), present);
                return ownersFilterFacts(scope, present, get(this.listsAtom) > 0);
            }),
            (facts) => facts,
            sameOwnersFilterFacts
        );
    }
}
