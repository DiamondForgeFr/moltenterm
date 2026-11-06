// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's host in a window (FR-BOSS-009, #2002): the layer over the content that holds what is not the sidebar's. It
// starts what listens (the hub's feeds, the hand-off requests that wait, the usage readings, his expressions), hangs the
// avatar from the window's top edge when the sidebar is not on screen, and draws his panel (the Sessions card until the
// panel story) where it opens. The avatar of the sidebar's row and the visit scene are the sidebar's own
// (workspace-sidebar.tsx); the bubble at the bottom right, the pennant and the hover comm screen are gone.

import { globalStore } from "@/app/store/jotaiStore";
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./boss-card.css";
import { BossCard } from "./boss-card";
import { BrokkAvatar } from "./brokk-avatar";
import { CardPlace, cardPlace, hangingRightPx, Rect } from "./brokk-avatar-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkHubModel } from "./brokk-hub-store";
import { BossBubbleModel } from "./boss-store";

function rectOf(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
}

// The card opens beside the sidebar from under the avatar that opened it; with no sidebar on screen, under the avatar
// that hangs from the window's edge.
function useCardPlace(layerRef: React.RefObject<HTMLDivElement>, open: boolean, onScreen: boolean): CardPlace {
    const [place, setPlace] = useState<CardPlace>(null);
    useLayoutEffect(() => {
        const layer = layerRef.current;
        const avatar = document.querySelector("[data-brokk-avatar]");
        if (!open || layer == null || avatar == null) {
            setPlace(null);
            return;
        }
        const sidebar = onScreen ? document.querySelector("[data-testid='workspace-sidebar']") : null;
        setPlace(cardPlace(rectOf(avatar), sidebar == null ? null : rectOf(sidebar), rectOf(layer)));
    }, [layerRef, open, onScreen]);
    return place;
}

function BrokkHostLayer() {
    const boss = BossBubbleModel.getInstance();
    const hubModel = BrokkHubModel.getInstance();
    const cardOpen = useAtomValue(boss.cardOpenAtom, { store: globalStore });
    const onScreen = useAtomValue(hubModel.sidebarOnScreenAtom, { store: globalStore });
    const layerRef = useRef<HTMLDivElement>(null);
    const place = useCardPlace(layerRef, cardOpen, onScreen);

    useEffect(() => boss.attach(document), [boss]);
    useEffect(() => hubModel.start(), [hubModel]);
    useEffect(() => BrokkExpressionsModel.getInstance().watch(document), []);

    return (
        <div ref={layerRef} className="mt-boss-layer" data-testid="boss-layer">
            {onScreen ? null : <BrokkAvatar variant="hanging" style={{ right: hangingRightPx(isMacOS()) }} />}
            {cardOpen && place != null ? <BossCard style={place} /> : null}
        </div>
    );
}

// The host of the window, or nothing when Settings turned Brokk off (FR-BOSS-001, AC9): then no avatar shows either, and
// nothing listens.
export function BrokkHubHost() {
    const show = useAtomValue(BossBubbleModel.getInstance().showAtom, { store: globalStore });
    return show ? <BrokkHostLayer /> : null;
}
