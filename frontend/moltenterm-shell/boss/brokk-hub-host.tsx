// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's host in a window (FR-BOSS-009, #2002, #2003, #2032): the layer over the content that holds what is not the
// sidebar's. It starts what listens (the hub's feeds, the hand-off requests that wait, the usage readings, his expressions),
// hangs the avatar from the window's top edge when there is no sidebar (a collapsed one keeps him on its strip, #2070),
// and draws his floating group where it opens. The avatar of the sidebar's row and the visit scene are the sidebar's own (workspace-sidebar.tsx); the bubble at the
// bottom right, the pennant, the hover comm screen, the bell and the cup are gone.
//
// With Brokk turned off (Settings) there is no avatar and no visit, but the group can still be opened by a gesture on one
// of its panels (a toast's Open, the downloads pill, the command palette), so the notifications and the downloads the
// bell held stay reachable. What the bell hosted without drawing (the toasts, the approval dialogs, the listeners) is
// the NotificationHost, mounted whatever the setting.

import { globalStore } from "@/app/store/jotaiStore";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { BrainstormStateAtom } from "../brainstorm/brainstorm-boot";
import { BrainstormLayer } from "../brainstorm/brainstorm-layer";
import { prefersReducedMotion } from "../molten-motion";
import { NotificationHost } from "../notification-center";
import { BossBubbleModel } from "./boss-store";
import { BrokkAvatar } from "./brokk-avatar";
import { hangingRightPx, Rect as ScreenRect } from "./brokk-avatar-model";
import type { EdgeShape, SidebarPlace } from "./brokk-edge-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkGroup, GroupFrame, preloadUsageBlock } from "./brokk-group";
import { dockedPlace, groupGeometry } from "./brokk-group-model";
import "./brokk-group.css";
import { BrokkHubModel } from "./brokk-hub-store";
import { DefaultPeekInsetPx, matrixXOf, mooredFrame, sameMooredFrame, Slide, slideOf } from "./brokk-mooring-model";
import { BrokkSession } from "./brokk-session";

// How long after the window is up the usage block of his group is loaded.
const UsageBlockLoadDelayMs = 2000;

// The group is kept on screen this long after it was asked to leave, for its leaving motion.
export const LeaveMs = 560;
export const LeaveReducedMs = 150;

function rectOf(element: Element): ScreenRect {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
}

// The frame's margin around the window area (the Spaces frame's --mt-frame-gap, inherited by the layer), 0 without a
// frame: the panels start that far into the layer (#2082).
export function frameInset(layer: Element): number {
    const gap = parseFloat(getComputedStyle(layer).getPropertyValue("--mt-frame-gap"));
    return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

function shiftOf(element: Element): number {
    return matrixXOf(getComputedStyle(element).transform).tx;
}

function cssPx(element: Element, name: string, fallback: number): number {
    const value = parseFloat(getComputedStyle(element).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
}

// The sidebar's running slide, read from its CSS transitions, so the group moves in the same time and curve.
function slideOfElement(element: Element): Slide {
    const animations = typeof element.getAnimations === "function" ? element.getAnimations() : [];
    return slideOf(
        animations.map((animation) => {
            const timing = animation.effect?.getComputedTiming?.();
            return {
                property: (animation as CSSTransition).transitionProperty ?? "",
                running: animation.playState === "running",
                durationMs: Number(timing?.activeDuration ?? 0),
                elapsedMs: Number(timing?.localTime ?? 0) - Number(timing?.delay ?? 0),
                easing: String(animation.effect?.getTiming?.().easing ?? ""),
            };
        })
    );
}

// Where the group stands and where it arrives from, in the layer's coordinates: 8 px right of the sidebar and 8 px from
// the top of the window area; from the title-bar face that opened it. It follows the window's size while it is open,
// and the sidebar as it hides, comes back, docks or collapses (#2421): measured as the sidebar starts to slide, the
// frame is where the slide lands, and it carries the slide's time and curve for the group to move with it. During a
// brainstorm the group docks at the window's top left, whatever the sidebar's strip (#2257).
function useGroupFrame(
    layerRef: React.RefObject<HTMLDivElement>,
    open: boolean,
    sidebarPlace: SidebarPlace,
    brainstorming: boolean
): GroupFrame {
    const sidebarAt = dockedPlace(sidebarPlace, brainstorming);
    const [frame, setFrame] = useState<GroupFrame>(null);
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (!open || layer == null) {
            return;
        }
        const sidebarElement = document.querySelector("[data-testid='workspace-sidebar']");
        const measure = () => {
            const avatar = document.querySelector("[data-brokk-avatar]");
            const sidebar = sidebarAt === "screen" || sidebarAt === "edge" ? sidebarElement : null;
            const inset = frameInset(layer);
            const moored = mooredFrame({
                layer: rectOf(layer),
                inset,
                g: groupGeometry(),
                // The strip of a collapsed sidebar (#2070) is the sidebar itself, slid out of the window but its strip:
                // its box gives its real right edge, whatever the strip's width (#2082), and the thread runs back to the
                // face in the strip. The layer starts at that edge too (the content's margin).
                sidebar:
                    sidebar == null
                        ? null
                        : {
                              box: rectOf(sidebar),
                              shift: shiftOf(sidebar),
                              draw: {
                                  hidden: sidebar.classList.contains("is-hidden"),
                                  peek: sidebar.classList.contains("is-peek"),
                                  edge: (sidebar.getAttribute("data-edge") as EdgeShape) ?? null,
                              },
                              gap: inset,
                          },
                edgeOnly: sidebar == null && sidebarAt === "edge",
                face:
                    avatar == null
                        ? null
                        : {
                              box: rectOf(avatar),
                              shift: shiftOf(avatar),
                              edge: avatar.classList.contains("is-edge"),
                              peekInset: cssPx(avatar, "--mt-peek-inset", DefaultPeekInsetPx),
                          },
            });
            const slide = sidebar == null ? null : slideOfElement(sidebar);
            setFrame((before) => (sameMooredFrame(before, moored) ? before : { ...moored, slide }));
        };
        measure();
        window.addEventListener("resize", measure);
        // The sidebar hides, floats out, docks or shows its strip by its class and its data-edge: the group follows.
        // Drawn before the next paint: the layer has already moved with the content when the sidebar docks, and a frame
        // drawn with the old place would show the group a sidebar's width away for a moment.
        const remeasure = () => flushSync(measure);
        const observer = typeof MutationObserver === "function" ? new MutationObserver(remeasure) : null;
        if (observer != null && sidebarElement != null) {
            observer.observe(sidebarElement, { attributes: true, attributeFilter: ["class", "data-edge"] });
        }
        return () => {
            window.removeEventListener("resize", measure);
            observer?.disconnect();
        };
    }, [layerRef, open, sidebarAt]);
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
    const place = useAtomValue(hubModel.sidebarPlaceAtom, { store: globalStore });
    const layerRef = useRef<HTMLDivElement>(null);
    const brainstorming = useAtomValue(BrainstormStateAtom, { store: globalStore })?.open === true;
    const frame = useGroupFrame(layerRef, cardOpen, place, brainstorming);
    const life = useGroupLife(cardOpen);

    useEffect(() => boss.attach(document), [boss]);
    // The feeds run whatever the switch: off, the hub raises nothing but keeps the rail's badge keys current (#2218).
    useEffect(() => hubModel.start(), [hubModel]);
    // The usage block of his group loads once the window is up, outside the JavaScript it loads up front, so that it is
    // there when the group opens (#2341).
    useEffect(() => {
        const timer = setTimeout(() => fireAndForget(() => preloadUsageBlock()), UsageBlockLoadDelayMs);
        return () => clearTimeout(timer);
    }, []);
    useEffect(() => (show ? BrokkExpressionsModel.getInstance().watch(document) : undefined), [show]);
    // The session a restart left, so that the ring turns for it, and his one talk, the same in every page (AC99, #2382).
    useEffect(() => {
        if (!show) {
            return;
        }
        const session = BrokkSession.getInstance();
        void session.find();
        return session.start();
    }, [show]);

    return (
        <div ref={layerRef} className="mt-boss-layer" data-testid="boss-layer">
            {/* His thought in 3D (FR-BOSS-010, #2246): under his group, above the app; on every channel since #2320. */}
            <BrainstormLayer />
            {show && place === "none" ? (
                <BrokkAvatar variant="hanging" style={{ right: hangingRightPx(isMacOS()) }} />
            ) : null}
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
