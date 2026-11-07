// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's host in a window (FR-BOSS-009, #2002, #2003, #2032): the layer over the content that holds what is not the
// sidebar's. It starts what listens (the hub's feeds, the hand-off requests that wait, the usage readings, his expressions),
// hangs the avatar from the window's top edge when the sidebar is not on screen, and draws his floating group where it
// opens. The avatar of the sidebar's row and the visit scene are the sidebar's own (workspace-sidebar.tsx); the bubble at the
// bottom right, the pennant, the hover comm screen, the bell and the cup are gone.
//
// With Brokk turned off (Settings) there is no avatar and no visit, but the group can still be opened by a gesture on one
// of its panels (a toast's Open, the downloads pill, the command palette), so the notifications and the downloads the
// bell held stay reachable. What the bell hosted without drawing (the toasts, the approval dialogs, the listeners) is
// the NotificationHost, mounted whatever the setting.

import { globalStore } from "@/app/store/jotaiStore";
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { NotificationHost } from "../notification-center";
import { BossBubbleModel } from "./boss-store";
import { BrokkAvatar } from "./brokk-avatar";
import { hangingRightPx, Rect as ScreenRect } from "./brokk-avatar-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkGroup, GroupFrame } from "./brokk-group";
import { groupGeometry, groupPlace } from "./brokk-group-model";
import "./brokk-group.css";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkSession } from "./brokk-session";

// The group is kept on screen this long after it was asked to leave, for its leaving motion.
export const LeaveMs = 560;
export const LeaveReducedMs = 150;

function rectOf(element: Element): ScreenRect {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
}

// Where the group stands and where it arrives from, in the layer's coordinates: 8 px right of the sidebar and 8 px from
// the top of the window area; from the title-bar face that opened it. It follows the window's size while it is open.
function useGroupFrame(layerRef: React.RefObject<HTMLDivElement>, open: boolean, onScreen: boolean): GroupFrame {
    const [frame, setFrame] = useState<GroupFrame>(null);
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (!open || layer == null) {
            return;
        }
        const measure = () => {
            const box = rectOf(layer);
            const avatar = document.querySelector("[data-brokk-avatar]");
            const sidebar = onScreen ? document.querySelector("[data-testid='workspace-sidebar']") : null;
            const g = groupGeometry();
            const sidebarBox = sidebar == null ? null : rectOf(sidebar);
            const place = groupPlace(
                sidebarBox == null
                    ? null
                    : {
                          x: sidebarBox.left - box.left,
                          y: sidebarBox.top - box.top,
                          w: sidebarBox.width,
                          h: sidebarBox.height,
                      },
                { width: box.width, height: box.height },
                g
            );
            const face = avatar == null ? null : rectOf(avatar);
            const origin =
                face == null
                    ? null
                    : { x: face.left + face.width / 2 - box.left, y: face.top + face.height / 2 - box.top };
            // The thread runs from the face to the square's edge, level with the face, kept inside the square's height.
            const faceRight = face == null ? 0 : face.left + face.width - box.left;
            const thread =
                sidebarBox != null && origin != null && place.left - faceRight > 0
                    ? {
                          x: faceRight,
                          y: Math.min(Math.max(origin.y, place.top + 6), place.top + g.square - 6) - 1,
                          w: place.left - faceRight,
                      }
                    : null;
            setFrame({ place, origin, thread });
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [layerRef, open, onScreen]);
    return frame;
}

// The group arrives after one frame, so that its starting place is painted first, and leaves before it is taken away.
export function useGroupLife(open: boolean): { mounted: boolean; shown: boolean } {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (open) {
            setMounted(true);
            let second = 0;
            const first = requestAnimationFrame(() => {
                second = requestAnimationFrame(() => setShown(true));
            });
            return () => {
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
            };
        }
        setShown(false);
        const timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? LeaveReducedMs : LeaveMs);
        return () => clearTimeout(timer);
    }, [open]);
    return { mounted, shown };
}

function BrokkHostLayer({ show }: { show: boolean }) {
    const boss = BossBubbleModel.getInstance();
    const hubModel = BrokkHubModel.getInstance();
    const cardOpen = useAtomValue(boss.cardOpenAtom, { store: globalStore });
    const onScreen = useAtomValue(hubModel.sidebarOnScreenAtom, { store: globalStore });
    const layerRef = useRef<HTMLDivElement>(null);
    const frame = useGroupFrame(layerRef, cardOpen, onScreen);
    const life = useGroupLife(cardOpen);

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
            {life.mounted && frame != null ? <BrokkGroup frame={frame} shown={life.shown && cardOpen} /> : null}
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
