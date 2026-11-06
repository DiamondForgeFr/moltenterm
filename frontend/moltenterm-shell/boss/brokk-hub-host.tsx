// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's host in a window (FR-BOSS-009, #2002, #2003): the layer over the content that holds what is not the sidebar's.
// It starts what listens (the hub's feeds, the hand-off requests that wait, the usage readings, his expressions), hangs
// the avatar from the window's top edge when the sidebar is not on screen, and draws his panel where it opens. The avatar
// of the sidebar's row and the visit scene are the sidebar's own (workspace-sidebar.tsx); the bubble at the bottom
// right, the pennant, the hover comm screen, the bell and the cup are gone.
//
// With Brokk turned off (Settings) there is no avatar and no visit, but the panel can still be opened by a gesture on one
// of its sections (a toast's Open, the downloads pill, the command palette), so the notifications and the downloads the
// bell held stay reachable. What the bell hosted without drawing (the toasts, the approval dialogs, the listeners) is
// the NotificationHost, mounted whatever the setting.

import { globalStore } from "@/app/store/jotaiStore";
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NotificationHost } from "../notification-center";
import { BossBubbleModel } from "./boss-store";
import { BrokkAvatar } from "./brokk-avatar";
import { CardPlace, cardPlace, hangingRightPx, Rect } from "./brokk-avatar-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkPanel } from "./brokk-panel";
import "./brokk-panel.css";
import { BrokkSession } from "./brokk-session";

function rectOf(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
}

// The panel opens beside the sidebar from under the avatar that opened it; with no sidebar on screen, under the avatar
// that hangs from the window's edge; with no avatar at all (Brokk turned off), at the window's top right.
function usePanelPlace(layerRef: React.RefObject<HTMLDivElement>, open: boolean, onScreen: boolean): CardPlace {
    const [place, setPlace] = useState<CardPlace>(null);
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (!open || layer == null) {
            setPlace(null);
            return;
        }
        const avatar = document.querySelector("[data-brokk-avatar]");
        const sidebar = onScreen ? document.querySelector("[data-testid='workspace-sidebar']") : null;
        setPlace(
            cardPlace(avatar == null ? null : rectOf(avatar), sidebar == null ? null : rectOf(sidebar), rectOf(layer))
        );
    }, [layerRef, open, onScreen]);
    return place;
}

function BrokkHostLayer({ show }: { show: boolean }) {
    const boss = BossBubbleModel.getInstance();
    const hubModel = BrokkHubModel.getInstance();
    const cardOpen = useAtomValue(boss.cardOpenAtom, { store: globalStore });
    const onScreen = useAtomValue(hubModel.sidebarOnScreenAtom, { store: globalStore });
    const layerRef = useRef<HTMLDivElement>(null);
    const place = usePanelPlace(layerRef, cardOpen, onScreen);

    useEffect(() => boss.attach(document), [boss]);
    useEffect(() => (show ? hubModel.start() : undefined), [hubModel, show]);
    useEffect(() => (show ? BrokkExpressionsModel.getInstance().watch(document) : undefined), [show]);
    // The session a restart left, so that the ring turns for it.
    useEffect(() => {
        if (show) {
            void BrokkSession.getInstance().find();
        }
    }, [show]);

    return (
        <div ref={layerRef} className="mt-boss-layer" data-testid="boss-layer">
            {show && !onScreen ? <BrokkAvatar variant="hanging" style={{ right: hangingRightPx(isMacOS()) }} /> : null}
            {cardOpen && place != null ? <BrokkPanel style={place} /> : null}
        </div>
    );
}

export function BrokkHubHost() {
    const show = useAtomValue(BossBubbleModel.getInstance().showAtom, { store: globalStore });
    return (
        <>
            <NotificationHost />
            <BrokkHostLayer show={show} />
        </>
    );
}
