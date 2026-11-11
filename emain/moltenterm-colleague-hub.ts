// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows of Brokk as a kind colleague (FR-BOSS-009, #2221): which pages listen, what they say and what they are told.
// Every page of every window speaks to the one owner (moltenterm-colleague-owner.ts) and hears the same moments. The
// Electron glue (moltenterm-colleague.ts) binds the IPC to these methods; nothing here imports Electron, so two windows
// can be played by two stand-ins.

import { Moment } from "../frontend/moltenterm-shell/boss/brokk-colleague";
import { momentIdOf, MomentsUpdate, pageFactsOf } from "../frontend/moltenterm-shell/boss/brokk-colleague-wire";
import { ColleagueOwner, OwnerDeps } from "./moltenterm-colleague-owner";

export type PageLike = {
    // The page's identity: its web contents.
    id: number;
    send: (update: MomentsUpdate) => void;
    alive: () => boolean;
};

export class ColleagueHub {
    readonly owner: ColleagueOwner;
    private pages = new Map<number, PageLike>();

    constructor(deps: Omit<OwnerDeps, "publish">, text: string) {
        this.owner = new ColleagueOwner({ ...deps, publish: (update) => this.broadcast(update) }, text);
    }

    private broadcast(update: MomentsUpdate): void {
        for (const [id, page] of [...this.pages]) {
            if (!page.alive()) {
                this.stop(id);
                continue;
            }
            try {
                page.send(update);
            } catch {
                // A page that cannot be told is gone or loading; it asks again when it starts.
            }
        }
    }

    // A page listens: it is told the moments as they now are, and every change after.
    start(page: PageLike, rawFacts: unknown): MomentsUpdate {
        this.pages.set(page.id, page);
        this.owner.setFacts(pageFactsOf(rawFacts));
        this.owner.setListening(true);
        return this.owner.update();
    }

    stop(pageId: number): void {
        if (!this.pages.delete(pageId)) {
            return;
        }
        if (this.pages.size === 0) {
            this.owner.setListening(false);
        }
    }

    listening(): number {
        return this.pages.size;
    }

    facts(rawFacts: unknown): void {
        this.owner.setFacts(pageFactsOf(rawFacts));
    }

    input(rawFacts: unknown): void {
        this.owner.noteInput(pageFactsOf(rawFacts));
    }

    shown(rawId: unknown): Moment {
        const id = momentIdOf(rawId);
        return id == null ? null : this.owner.noteShown(id);
    }

    seen(rawId: unknown): void {
        const id = momentIdOf(rawId);
        if (id != null) {
            this.owner.noteSeen(id);
        }
    }
}
