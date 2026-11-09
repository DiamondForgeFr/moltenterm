// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the collapsed sidebar tells of the news (FR-BOSS-009, AC28, #2070): how many times it has bounced for a new
// notification, and whether the badge holds something the developer has not looked at. The sidebar plays the bounce
// when the first changes; the face outlines the second under reduced motion. The rules are brokk-edge-model.ts's.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { edgeNewsAfter, EdgeNews, NoNews } from "./brokk-edge-model";

export class BrokkEdgeModel {
    private static instance: BrokkEdgeModel = null;

    // Counts the bounces told: a new value is a new notification, to be told once.
    bounceAtom = atom(0) as PrimitiveAtom<number>;
    unseenAtom = atom(false) as PrimitiveAtom<boolean>;
    private news: EdgeNews = NoNews;

    static getInstance(): BrokkEdgeModel {
        if (BrokkEdgeModel.instance == null) {
            BrokkEdgeModel.instance = new BrokkEdgeModel();
        }
        return BrokkEdgeModel.instance;
    }

    // What the badge counts now, whether the developer is looking at it, and whether the feeds have been read. `coming`
    // are the keys set to Vient, the only ones that move the sidebar (#2155).
    tell(keys: string[], looking: boolean, ready: boolean, coming: string[] = keys): void {
        const step = edgeNewsAfter(this.news, keys, coming, looking, ready);
        this.news = step.news;
        if (step.fresh) {
            globalStore.set(this.bounceAtom, globalStore.get(this.bounceAtom) + 1);
        }
        if (globalStore.get(this.unseenAtom) !== step.unseen) {
            globalStore.set(this.unseenAtom, step.unseen);
        }
    }

    reset(): void {
        this.news = NoNews;
        globalStore.set(this.bounceAtom, 0);
        globalStore.set(this.unseenAtom, false);
    }
}
