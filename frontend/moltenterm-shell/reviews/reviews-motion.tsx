// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews cards' motion (#1063, FR-REV-001 AC14): cards arrive, leave, slide to their new place and travel between
// sections instead of jumping. FLIP with the Web Animations API, transform and opacity only, never the View Transitions
// API (the page receives no click during a view transition) and never pointer-events: none on a card, so its buttons
// respond during every animation. What plays comes from reviews-motion-model.ts.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { Component, createRef, ReactNode } from "react";
import { CardPlace, layoutSignature, Motion, motionPlan, ReviewsSeen } from "./reviews-motion-model";

const MotionId = "mt-card-motion";
const ArriveId = "mt-card-arrive";
const CardSelector = "[data-pr][data-turn]";

type CardMotionProps = {
    dir: string;
    layout: CardPlace[];
    merged: number[];
    // What sits above the cards and changes their place with the data (the after-merge line, the queue): when it
    // changes, the cards slide to their new place too.
    around?: string;
    children: ReactNode;
};

type LeavingCard = { number: number; node: HTMLElement; rect: DOMRect };

type MotionSnapshot = { rects: Map<number, DOMRect>; leaving: LeavingCard[] };

function numbersOf(layout: CardPlace[]): number[] {
    return layout.map((p) => p.number);
}

function canAnimate(el: Element): el is HTMLElement {
    return typeof (el as HTMLElement).animate === "function";
}

function motionsOf(el: Element, ids = [MotionId, ArriveId]): Animation[] {
    return (el.getAnimations?.() ?? []).filter((a) => ids.includes(a.id));
}

// The first opaque background behind the list: cards are transparent, and two crossing cards would mix their text. A
// transparent window (a translucent theme) has none: the app's main background then.
function surfaceOf(el: HTMLElement): string {
    for (let at = el; at != null; at = at.parentElement) {
        const bg = getComputedStyle(at).backgroundColor;
        if (bg.startsWith("rgb(")) {
            return bg;
        }
    }
    return "var(--main-bg-color)";
}

function reducedMotion(): boolean {
    return !!globalStore.get(atoms.prefersReducedMotionAtom);
}

// Wraps the sections. A class component for getSnapshotBeforeUpdate: it reads each card's place right before React
// moves the DOM, including the offset of a motion still running, so an interrupted motion goes on from where the card
// is seen. It reads only when the layout's data changed, so a hover or a poll that changes nothing costs no layout read.
export class CardMotion extends Component<CardMotionProps> {
    root = createRef<HTMLDivElement>();
    ghosts = new Set<HTMLElement>();
    openLists = new Map<HTMLElement, number>();
    lifts = 0;

    componentDidMount(): void {
        ReviewsSeen.getInstance().note(this.props.dir, numbersOf(this.props.layout), true);
    }

    componentWillUnmount(): void {
        for (const ghost of this.ghosts) {
            ghost.remove();
        }
        this.ghosts.clear();
    }

    getSnapshotBeforeUpdate(prev: CardMotionProps): MotionSnapshot {
        if (
            prev.dir !== this.props.dir ||
            (prev.around === this.props.around && layoutSignature(prev.layout) === layoutSignature(this.props.layout))
        ) {
            return null;
        }
        const root = this.root.current;
        if (root == null) {
            return null;
        }
        const next = new Set(numbersOf(this.props.layout));
        const rects = new Map<number, DOMRect>();
        const leaving: LeavingCard[] = [];
        for (const el of root.querySelectorAll<HTMLElement>(CardSelector)) {
            const number = Number(el.getAttribute("data-pr"));
            const rect = el.getBoundingClientRect();
            rects.set(number, rect);
            if (!next.has(number)) {
                leaving.push({ number, node: el.cloneNode(true) as HTMLElement, rect });
            }
        }
        return { rects, leaving };
    }

    componentDidUpdate(prev: CardMotionProps, _state: unknown, snap: MotionSnapshot): void {
        const { dir, layout } = this.props;
        if (prev.dir !== dir) {
            ReviewsSeen.getInstance().note(dir, numbersOf(layout), true);
            return;
        }
        if (snap == null) {
            return;
        }
        const fresh = ReviewsSeen.getInstance().note(dir, numbersOf(layout), false);
        this.play(motionPlan(prev.layout, layout, fresh), snap);
    }

    play(plan: ReturnType<typeof motionPlan>, snap: MotionSnapshot) {
        const root = this.root.current;
        if (root == null) {
            return;
        }
        const reduced = reducedMotion();
        const merged = new Set(this.props.merged);
        let left = false;
        for (const card of snap.leaving) {
            left = this.leave(card, merged.has(card.number), reduced) || left;
        }
        const els = new Map<number, HTMLElement>();
        // A card still waiting for a leaving card to fade keeps waiting when a new layout comes meanwhile.
        const waits = new Map<number, number>();
        for (const el of root.querySelectorAll<HTMLElement>(CardSelector)) {
            if (!canAnimate(el)) {
                continue;
            }
            const number = Number(el.getAttribute("data-pr"));
            // An arrival keeps fading in: a slide replaces only its transform.
            for (const a of motionsOf(el, [MotionId])) {
                const wait = Number(a.effect?.getTiming().delay ?? 0) - Number(a.currentTime ?? 0);
                if (wait > 0) {
                    waits.set(number, wait);
                }
                a.cancel();
            }
            els.set(number, el);
        }
        for (const number of plan.arrive) {
            const el = els.get(number);
            if (el == null) {
                continue;
            }
            if (reduced) {
                el.animate([{ opacity: 0 }, { opacity: 1 }], { id: ArriveId, duration: Motion.reducedMs });
                continue;
            }
            el.animate(
                [
                    { opacity: 0, transform: `translateY(${Motion.arriveOffsetPx}px)` },
                    { opacity: 1, transform: "none" },
                ],
                { id: ArriveId, duration: Motion.arriveMs, easing: Motion.ease }
            );
        }
        const surface = reduced ? "" : surfaceOf(root.parentElement);
        // A leaving card fades first; the others wait for it, then slide up into its place.
        const delay = left && !reduced ? Motion.leaveMs : 0;
        for (const number of plan.travel) {
            const el = els.get(number);
            if (el == null) {
                continue;
            }
            if (reduced) {
                el.animate([{ opacity: 0 }, { opacity: 1 }], { id: MotionId, duration: Motion.reducedMs });
                continue;
            }
            const wait = Math.max(delay, waits.get(number) ?? 0);
            this.slide(el, snap.rects.get(number), Motion.travelMs, wait, surface, true);
        }
        if (reduced) {
            return;
        }
        for (const number of plan.slide) {
            const el = els.get(number);
            if (el != null) {
                const wait = Math.max(delay, waits.get(number) ?? 0);
                this.slide(el, snap.rects.get(number), Motion.reorderMs, wait, surface, false);
            }
        }
    }

    slide(el: HTMLElement, before: DOMRect, duration: number, delay: number, surface: string, travel: boolean) {
        if (before == null) {
            return;
        }
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
            return;
        }
        const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            id: MotionId,
            duration,
            delay,
            easing: Motion.ease,
            fill: "backwards",
        });
        this.lift(el, anim, surface, travel || Math.abs(dy) > after.height);
        this.openList(el.parentElement, anim);
    }

    // While it moves, a card gets the surface behind it, and a card that jumps over others passes above them. Set once
    // per motion, not animated. The token keeps the cancelled motion's late event from undoing the next one's lift.
    lift(el: HTMLElement, anim: Animation, surface: string, above: boolean) {
        const token = String((this.lifts = this.lifts + 1));
        el.dataset.motion = token;
        el.style.backgroundColor = surface;
        el.style.zIndex = above ? "1" : "";
        const drop = () => {
            if (el.dataset.motion !== token) {
                return;
            }
            delete el.dataset.motion;
            el.style.backgroundColor = "";
            el.style.zIndex = "";
        };
        anim.addEventListener("finish", drop);
        anim.addEventListener("cancel", drop);
    }

    // A section's list clips its cards to its rounded corners; a card that starts outside it (travelling in from another
    // section, or pushed along with the whole list) would be cut, so the list shows its overflow while a card moves
    // (no change of layout).
    openList(list: HTMLElement, anim: Animation) {
        if (list == null) {
            return;
        }
        this.openLists.set(list, (this.openLists.get(list) ?? 0) + 1);
        list.style.overflow = "visible";
        const close = () => {
            const count = (this.openLists.get(list) ?? 1) - 1;
            if (count > 0) {
                this.openLists.set(list, count);
                return;
            }
            this.openLists.delete(list);
            list.style.overflow = "";
        };
        anim.addEventListener("finish", close);
        anim.addEventListener("cancel", close);
    }

    // The card is gone from the DOM: a still copy of it, which takes no click, fades out at its place.
    leave(card: LeavingCard, merged: boolean, reduced: boolean): boolean {
        const container = this.root.current?.parentElement;
        if (container == null || !canAnimate(card.node)) {
            return false;
        }
        const ghost = card.node;
        const rail = ghost.querySelector<HTMLElement>('[data-testid="reviews-card-rail"]');
        if (merged && rail != null) {
            rail.style.background = "var(--mt-state-done)";
        }
        for (const el of [ghost, ...ghost.querySelectorAll("[data-pr], [data-turn], [data-testid], [id]")]) {
            el.removeAttribute("data-pr");
            el.removeAttribute("data-turn");
            el.removeAttribute("data-testid");
            el.removeAttribute("id");
        }
        ghost.removeAttribute("role");
        ghost.removeAttribute("tabindex");
        ghost.setAttribute("aria-hidden", "true");
        ghost.setAttribute("inert", "");
        const box = container.getBoundingClientRect();
        Object.assign(ghost.style, {
            position: "absolute",
            left: `${card.rect.left - box.left - container.clientLeft + container.scrollLeft}px`,
            top: `${card.rect.top - box.top - container.clientTop + container.scrollTop}px`,
            width: `${card.rect.width}px`,
            height: `${card.rect.height}px`,
            margin: "0",
            boxSizing: "border-box",
            pointerEvents: "none",
        });
        container.appendChild(ghost);
        this.ghosts.add(ghost);
        const anim = reduced
            ? ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
                  duration: Motion.reducedMs,
                  fill: "forwards",
              })
            : ghost.animate(
                  [
                      { opacity: 1, transform: "none" },
                      { opacity: 0, transform: `translateX(${Motion.leaveOffsetPx}px)` },
                  ],
                  { duration: Motion.leaveMs, easing: Motion.leaveEase, fill: "forwards" }
              );
        const done = () => {
            ghost.remove();
            this.ghosts.delete(ghost);
        };
        anim.addEventListener("finish", done);
        anim.addEventListener("cancel", done);
        return true;
    }

    // A click on a moving card is taken at once, and finishes its motion at its end place.
    onClickCapture = (e: React.MouseEvent) => {
        const card = (e.target as HTMLElement).closest?.(CardSelector);
        if (card == null) {
            return;
        }
        for (const a of motionsOf(card)) {
            a.finish();
        }
    };

    render() {
        return (
            <div ref={this.root} className="contents" onClickCapture={this.onClickCapture}>
                {this.props.children}
            </div>
        );
    }
}
