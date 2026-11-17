// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's owners filter as the panel's header carries it (FR-REV-034 AC12, #2207): a funnel icon button
// among the header's icon buttons and, while a filter is on, the agents' first names next to the title. Both open the
// owners menu, which the list the filter applies to draws (OwnersFilterHost). One OwnersFilter per panel.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { createElement } from "react";
import { AgentStates } from "../agent-state-store";
import { I18nModel, labelled, t } from "../i18n/i18n";
import { OwnersFilterIcon } from "./reviews-owners-icon";
import {
    effectiveScope,
    NoOwnersFilter,
    ownersFilterFacts,
    OwnersFilterFacts,
    ownersHeaderElems,
    OwnersWords,
    presentAgentNames,
    sameOwnersFilterFacts,
} from "./reviews-owners-model";
import { ViewScope } from "./reviews-owners-store";

// Where the open menu hangs: the lower right corner of the button it belongs to.
export type OwnersMenuAnchor = { right: number; bottom: number };

// What opens the menu: a mouse press on one of these is the toggle's business, not an outside click.
export const OwnersTriggerSelector = ".mt-owners-filter, .mt-owners-names";

const HeaderSelector = ".block-frame-default-header";
const FallbackBottomPx = 40;
const FallbackRightPx = 8;

// ownersMenuAnchor: under the funnel button when the header holds it; else under what was clicked (the "⋯" a narrow
// header folds the button into); else a corner, for a click that carries no element.
export function ownersMenuAnchor(e: Pick<React.MouseEvent<any>, "currentTarget" | "target">): OwnersMenuAnchor {
    const el = (e?.currentTarget ?? e?.target) as Element;
    const target = el?.closest?.(HeaderSelector)?.querySelector?.(".mt-owners-filter") ?? el?.closest?.("button") ?? el;
    const rect = target?.getBoundingClientRect?.();
    if (rect == null) {
        return { right: window.innerWidth - FallbackRightPx, bottom: FallbackBottomPx };
    }
    return { right: rect.right, bottom: rect.bottom };
}

export class OwnersFilter {
    blockId: string;
    // How many lists the filter applies to are on screen: the project's list, or the list of all projects. The filter
    // shows only while one is.
    listsAtom = atom(0) as PrimitiveAtom<number>;
    menuAtom = atom(null) as PrimitiveAtom<OwnersMenuAnchor>;
    // How many names the header's room holds, null until measured (OwnersNamesFit).
    shownAtom = atom(null) as PrimitiveAtom<number>;
    factsAtom: Atom<OwnersFilterFacts>;
    buttonsAtom: Atom<IconButtonDecl[]>;
    textAtom: Atom<HeaderElem[]>;

    toggle = (e: React.MouseEvent<any>) => {
        e?.stopPropagation?.();
        if (globalStore.get(this.menuAtom) != null) {
            globalStore.set(this.menuAtom, null);
            return;
        }
        globalStore.set(this.menuAtom, ownersMenuAnchor(e));
    };

    constructor(blockId: string) {
        this.blockId = blockId;
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
        const elems = atom((get) => {
            get(I18nModel.getInstance().localeAtom);
            const facts = get(this.factsAtom);
            const words: OwnersWords = {
                filter: t("reviews.owners.filterButton"),
                active: (names) => labelled(t("reviews.owners.label"), names),
            };
            const icon = createElement(OwnersFilterIcon, { filled: facts.names.length > 0 });
            return ownersHeaderElems(facts, get(this.shownAtom), get(this.menuAtom) != null, words, icon, this.toggle);
        });
        this.buttonsAtom = atom((get) => get(elems).buttons);
        this.textAtom = atom((get) => get(elems).text);
    }
}
