// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project tab's cards (FR-SHELL-015, DS-SHELL-015): the core lays them out, the cards themselves are
// contributions. Every built-in card registers here the way a mod's card will; there is no mod loader yet, only this
// list. A card names its region and its order inside it. The regions are the overview's slots, top to bottom
// (FR-MC-020, DS-MC-012): the header band, the line map, then the row of cards.

import type { ComponentType } from "react";

export type ProjectCardRegion = "header" | "map" | "cards";

export const ProjectCardRegions: ProjectCardRegion[] = ["header", "map", "cards"];

export type ProjectCard<P = any> = {
    id: string;
    title: string;
    region: ProjectCardRegion;
    order: number;
    // Drawn without the core's frame and title: the card frames itself (or shows nothing when it has nothing to say).
    bare?: boolean;
    component: ComponentType<P>;
};

export class ProjectCardRegistry<P = any> {
    cards: ProjectCard<P>[] = [];
    listeners = new Set<() => void>();

    // Registering an id again replaces its card (a mod overriding a built-in one); the returned function removes it.
    register(card: ProjectCard<P>): () => void {
        this.cards = [...this.cards.filter((c) => c.id !== card.id), card];
        this.notify();
        return () => {
            if (!this.cards.includes(card)) {
                return;
            }
            this.cards = this.cards.filter((c) => c !== card);
            this.notify();
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

// The cards of each region, in order; ties keep the registration order, so a contribution never jumps.
export function layoutProjectCards<P>(cards: readonly ProjectCard<P>[]): Record<ProjectCardRegion, ProjectCard<P>[]> {
    const rtn: Record<ProjectCardRegion, ProjectCard<P>[]> = { header: [], map: [], cards: [] };
    cards.forEach((card) => {
        if (!ProjectCardRegions.includes(card.region)) {
            return;
        }
        rtn[card.region].push(card);
    });
    for (const region of ProjectCardRegions) {
        rtn[region] = rtn[region]
            .map((card, index) => ({ card, index }))
            .sort((a, b) => a.card.order - b.card.order || a.index - b.index)
            .map((e) => e.card);
    }
    return rtn;
}
