// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace swipe on screen (FR-SHELL-082, DS-SHELL-130, #1248): wheel events go through the pure machine of
// sidebar-swipe.ts, and one requestAnimationFrame per display frame writes the result as transforms and opacities on
// a few elements held by ref (the page, the neighbour's likeness, the tint, the ring, the edge shadow). No React
// render happens while the fingers move. A switch is asked once the commit's settle landed on the neighbour's likeness
// (#1261): the view that appears shows the same place at rest, and its frame already has the tint's colour.

import type { WebviewTag } from "electron";
import { canScrollX, SwipeWheelChannel, SwipeWheelMessage } from "../view360/carpet-wheel";
import {
    absorbGapMs,
    arrivedSwipeState,
    CreatePageSides,
    heldRaw,
    initialSwipeState,
    LibrarySides,
    rawForOffset,
    ReleaseGapMs,
    settleDone,
    SwipeAbsorb,
    SwipeCtx,
    swipeLook,
    SwipeLook,
    swipeOffset,
    swipeReleaseAt,
    SwipeResult,
    SwipeSettle,
    SwipeSides,
    SwipeState,
    swipeTick,
    swipeTouch,
    swipeWheel,
    workspaceSides,
} from "./sidebar-swipe";
import type { SwitchIntent, SwitchSwipe } from "./sidebar-switch";

// A gesture over the content starts only when it is clearly sideways.
export const ContentIntentRatio = 2;
// A switch the main process refused (the developer kept the workspace) leaves this view on screen: it comes back.
const SwitchGiveUpMs = 1500;
// The ring's completion pulse lasts 260 ms (sidebar.css .mt-sb-pull.is-done); past this it is cleared anyway.
const PulseFallbackMs = 600;

export type SwipePlace = "sidebar" | "library" | "content";

// Where a wheel event may start a gesture: nothing under it scrolls sideways that way, it was not taken, and it is
// clearly sideways when it is over the content.
export function contentMayStart(
    e: { deltaX: number; deltaY: number; defaultPrevented: boolean; target: EventTarget },
    canScroll: (target: EventTarget, delta: number) => boolean
): boolean {
    if (e.defaultPrevented || e.deltaX === 0) {
        return false;
    }
    if (Math.abs(e.deltaX) < ContentIntentRatio * Math.abs(e.deltaY)) {
        return false;
    }
    return !canScroll(e.target, e.deltaX);
}

// Both halves of the ring turn: the right one fills the first half of the progress, the left one the second.
export function ringTurns(progress: number): { right: number; left: number } {
    const p = Math.max(0, Math.min(1, progress));
    return { right: Math.min(0.5, p) * 360, left: Math.max(0, p - 0.5) * 360 };
}

export type SwipeView = {
    page(): HTMLElement;
    ghost(side: -1 | 1): HTMLElement;
    tint(): HTMLElement;
    pull(side: -1 | 1): HTMLElement;
    shadow(side: -1 | 1): HTMLElement;
    library(): HTMLElement;
    aside(): HTMLElement;
    // The bottom bar's order and the current workspace; the page open over the workspace page, if any.
    position(): { ids: string[]; activeId: string; creating: boolean; otherPage: boolean };
    // The neighbour's frame colour, for the tint.
    tintColour(workspaceId: string): string;
    reduced(): boolean;
};

export type SwipeActions = {
    switchTo(workspaceId: string, side: -1 | 1, swipe: SwitchSwipe): void;
    openLibrary(): void;
    closeLibrary(): void;
    startCreate(): void;
    leaveCreate(): void;
};

type Gesture = { place: SwipePlace; ctx: SwipeCtx; neighbourIds: { prev: string; next: string } };

export class SidebarSwipeController {
    state: SwipeState = initialSwipeState();
    gesture: Gesture = null;
    frame = 0;
    releaseTimer: ReturnType<typeof setTimeout> = null;
    switchingUntil = 0;
    // A committed swipe's switch, asked once its settle lands.
    pendingSwitch: { target: string; side: -1 | 1 } = null;
    moved = new Set<HTMLElement>();
    view: SwipeView;
    actions: SwipeActions;

    constructor(view: SwipeView, actions: SwipeActions) {
        this.view = view;
        this.actions = actions;
    }

    // The aside's listener: not passive, the sidebar takes the horizontal gesture from the page behind.
    onAsideWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            return;
        }
        if (this.handle(e.deltaX, e.deltaY, e.timeStamp || performance.now(), "sidebar")) {
            e.preventDefault();
        }
    };

    // The window's listener, passive: the library, and the content when nothing there wants the gesture.
    onWindowWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            return;
        }
        const target = e.target as Node;
        if (this.view.aside()?.contains(target)) {
            return;
        }
        const at = e.timeStamp || performance.now();
        const lib = this.view.library();
        if (lib != null) {
            if (lib.contains(target) && (this.busy() || !canScrollX(e.target, e.deltaX))) {
                this.handle(e.deltaX, e.deltaY, at, "library");
            }
            return;
        }
        if (this.busy() || contentMayStart(e, canScrollX)) {
            this.handle(e.deltaX, e.deltaY, at, "content");
        }
    };

    // A web page's horizontal wheel it cannot use, forwarded by its preload.
    feedForwarded(dx: number, dy: number) {
        if (this.view.library() != null) {
            return;
        }
        if (!this.busy() && Math.abs(dx) < ContentIntentRatio * Math.abs(dy)) {
            return;
        }
        this.handle(dx, dy, performance.now(), "content");
    }

    // A gesture or its momentum is under way.
    busy(): boolean {
        return (
            this.state.phase !== "idle" || this.absorbing(performance.now()) || this.switchingUntil > performance.now()
        );
    }

    // The view a swipe switched to: the gesture's momentum follows, the next touch is taken at once.
    arrived(intent: SwitchIntent) {
        if (intent?.absorb == null) {
            return;
        }
        const a = intent.absorb;
        const absorb: SwipeAbsorb = {
            sign: a.sign,
            lastAbs: a.lastAbs,
            lastAt: a.lastAt - Date.now() + performance.now(),
        };
        this.state = arrivedSwipeState(absorb, this.state.touch);
    }

    // The view left the screen: whatever moved goes back to rest.
    reset() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        clearTimeout(this.releaseTimer);
        // The momentum stays absorbed: it may still arrive when this view comes back.
        this.state = { ...initialSwipeState(), absorb: this.state.absorb, touch: this.state.touch };
        this.gesture = null;
        this.switchingUntil = 0;
        this.pendingSwitch = null;
        this.clearStyles();
    }

    private gestureFor(place: SwipePlace): Gesture {
        const width = Math.max(1, this.view.page()?.getBoundingClientRect().width || 240);
        if (place === "library") {
            return { place, ctx: { width, sides: LibrarySides }, neighbourIds: { prev: null, next: null } };
        }
        const pos = this.view.position();
        if (pos.otherPage) {
            return null;
        }
        if (pos.creating) {
            return {
                place,
                ctx: { width, sides: CreatePageSides },
                neighbourIds: { prev: pos.activeId, next: null },
            };
        }
        const index = pos.ids.indexOf(pos.activeId);
        const sides: SwipeSides = workspaceSides(index, pos.ids.length);
        return {
            place,
            ctx: { width, sides },
            neighbourIds: { prev: pos.ids[index - 1] ?? null, next: pos.ids[index + 1] ?? null },
        };
    }

    // One wheel event; true when the swipe took it.
    handle(dx: number, dy: number, at: number, place: SwipePlace): boolean {
        // A view left keeps getting the gesture's momentum (the system latches a gesture to its view): it never acts.
        if (this.switchingUntil > performance.now() || globalThis.document?.visibilityState === "hidden") {
            const a = this.state.absorb;
            if (a != null && Math.sign(dx) === a.sign) {
                this.state = { ...this.state, absorb: { ...a, lastAbs: Math.abs(dx), lastAt: at } };
            }
            return true;
        }
        // From rest, each gesture reads where it starts: the page on screen may have changed (a pull opened one).
        if (this.state.phase === "idle") {
            if (Math.abs(dx) <= Math.abs(dy) && !this.absorbing(at)) {
                return false;
            }
            this.gesture = this.gestureFor(place);
            if (this.gesture == null) {
                return false;
            }
        }
        const r = swipeWheel(this.state, { dx, dy, at }, this.gesture.ctx);
        this.apply(r);
        return r.handled;
    }

    private absorbing(at: number): boolean {
        const a = this.state.absorb;
        return a != null && at - a.lastAt <= absorbGapMs(a);
    }

    private apply(r: SwipeResult) {
        this.state = r.state;
        if (r.grabbed) {
            this.prepare();
        }
        if (r.released) {
            this.released(r.released);
        }
        clearTimeout(this.releaseTimer);
        if (this.state.phase === "tracking") {
            // Wake when the release falls due (a slow stroke holds longer than a committing one); a held pull is
            // checked every ReleaseGapMs while it drains.
            const due = this.gesture == null ? null : swipeReleaseAt(this.state, this.gesture.ctx);
            const wait = due == null ? ReleaseGapMs : Math.max(0, due - performance.now());
            this.releaseTimer = setTimeout(() => this.tick(), wait + 4);
        }
        if (this.state.phase === "idle") {
            this.finish();
            return;
        }
        this.schedule();
    }

    private tick() {
        if (this.gesture == null) {
            return;
        }
        this.apply(swipeTick(this.state, performance.now(), this.gesture.ctx));
    }

    // A fresh touch: the tint takes the neighbour's colour, the moved layers get their own compositing.
    private prepare() {
        const g = this.gesture;
        if (g == null || g.place === "library") {
            return;
        }
        const tint = this.view.tint();
        if (tint == null) {
            return;
        }
        // The new-workspace page goes back to its own workspace: no other colour.
        const creating = g.ctx.sides === CreatePageSides;
        tint.dataset.prev = creating ? "" : (this.view.tintColour(g.neighbourIds.prev) ?? "");
        tint.dataset.next = creating ? "" : (this.view.tintColour(g.neighbourIds.next) ?? "");
    }

    private released(settle: SwipeSettle) {
        const g = this.gesture;
        if (g == null || settle.commit === 0) {
            return;
        }
        const side = settle.commit;
        if (g.place === "library") {
            if (this.view.reduced()) {
                this.actions.closeLibrary();
            }
            return;
        }
        if (settle.kind === "pull") {
            this.clearStyles();
            this.pulse(side);
            this.state = { ...this.state, phase: "idle", settle: null };
            if (side < 0) {
                this.actions.openLibrary();
            } else {
                this.actions.startCreate();
            }
            return;
        }
        const pos = this.view.position();
        if (pos.creating) {
            if (this.view.reduced()) {
                this.actions.leaveCreate();
            }
            return;
        }
        const target = side < 0 ? g.neighbourIds.prev : g.neighbourIds.next;
        if (target == null) {
            return;
        }
        // From here the gesture is spent: whatever follows is its momentum, absorbed until the view leaves.
        this.switchingUntil = performance.now() + SwitchGiveUpMs;
        this.pendingSwitch = { target, side };
        if (this.view.reduced()) {
            this.askSwitch(Math.min(1, Math.abs(settle.from) / g.ctx.width), settle.v0);
        }
    }

    // The switch is asked once the settle landed on the neighbour's likeness (#1261): the view that appears is at rest
    // where the settle ended, so nothing plays twice and no half-slid frame of either view shows. Asked at the release,
    // the new view played its slide while emain revealed it off-screen and reinitialised it, then landed on screen
    // already at rest: the motion jumped to its end.
    private askSwitch(offset: number, v0: number) {
        const pending = this.pendingSwitch;
        if (pending == null) {
            return;
        }
        this.pendingSwitch = null;
        const absorb = this.state.absorb;
        this.switchingUntil = performance.now() + SwitchGiveUpMs;
        this.actions.switchTo(pending.target, pending.side, {
            offset,
            v0,
            absorb:
                absorb == null
                    ? null
                    : {
                          sign: absorb.sign,
                          lastAbs: absorb.lastAbs,
                          lastAt: absorb.lastAt - performance.now() + Date.now(),
                      },
        });
    }

    // The full ring swells and fades as its page opens (#1312): the pull opens while the fingers still move, and this
    // marks the moment, like a haptic tick.
    private pulse(side: -1 | 1) {
        const pull = this.view.pull(side);
        if (pull == null || this.view.reduced()) {
            return;
        }
        const halves = Array.from(pull.querySelectorAll<HTMLElement>(".mt-sb-ring-half > i"));
        const turns = ringTurns(1);
        halves.forEach((half, i) => {
            half.style.transform = `rotate(${i === 0 ? turns.right : turns.left}deg)`;
        });
        const done = () => {
            clearTimeout(fallback);
            pull.removeEventListener("animationend", done);
            pull.classList.remove("is-done");
            if (!this.moved.has(pull)) {
                halves.forEach((half) => (half.style.transform = ""));
            }
        };
        // animationend never comes when the badge is hidden mid-animation.
        const fallback = setTimeout(done, PulseFallbackMs);
        pull.addEventListener("animationend", done);
        pull.classList.add("is-done");
    }

    // A touch phase source's signals (#1261): the fingers went down on the trackpad, or lifted. Nothing calls them yet;
    // see the PR of #1261 for where a real signal can come from.
    touch(phase: "begin" | "end") {
        // Only a tracking gesture reads the context, and a tracking gesture always has one.
        const r = swipeTouch(this.state, phase, performance.now(), this.gesture?.ctx);
        if (this.gesture == null) {
            this.state = r.state;
            return;
        }
        this.apply(r);
    }

    private schedule() {
        if (this.frame !== 0) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.render(performance.now());
        });
    }

    private render(now: number) {
        const g = this.gesture;
        if (g == null) {
            return;
        }
        const s = this.state;
        if (s.phase === "settling" && s.settle != null && settleDone(s.settle, now)) {
            this.settled(s.settle);
            return;
        }
        const offset = swipeOffset(s, now, g.ctx);
        const raw = s.phase === "tracking" ? heldRaw(s, now, g.ctx) : rawForOffset(offset, g.ctx);
        const look = swipeLook(offset, raw, g.ctx, this.view.reduced());
        if (g.place === "library") {
            this.drawLibrary(look, offset, g.ctx);
        } else {
            this.drawSidebar(look, g);
        }
        if (s.phase !== "idle") {
            this.schedule();
        }
    }

    private settled(settle: SwipeSettle) {
        const g = this.gesture;
        if (settle.commit !== 0 && g != null && settle.kind === "page") {
            if (g.place === "library") {
                this.actions.closeLibrary();
            } else if (this.view.position().creating) {
                this.actions.leaveCreate();
            } else {
                // The settle landed on the neighbour: the switch goes now, and this view keeps the settled look until
                // it leaves the screen.
                this.state = { ...this.state, phase: "idle", settle: null };
                this.askSwitch(1, 0);
                setTimeout(() => {
                    if (this.state.phase === "idle" && this.switchingUntil !== 0) {
                        this.reset();
                    }
                }, SwitchGiveUpMs);
                return;
            }
        }
        this.state = { ...this.state, phase: "idle", settle: null };
        this.finish();
    }

    // The gesture is over and its momentum absorbed or gone: the layers go back to their parked styles.
    private finish() {
        if (this.switchingUntil > performance.now()) {
            return;
        }
        this.gesture = null;
        this.clearStyles();
    }

    private move(el: HTMLElement, transform: string, opacity?: number) {
        if (el == null) {
            return;
        }
        if (!this.moved.has(el)) {
            this.moved.add(el);
            el.style.willChange = opacity == null ? "transform" : "transform, opacity";
            el.style.transition = "none";
        }
        el.style.transform = transform;
        if (opacity != null) {
            el.style.opacity = String(opacity);
        }
    }

    private fade(el: HTMLElement, opacity: number) {
        if (el == null) {
            return;
        }
        if (!this.moved.has(el)) {
            this.moved.add(el);
            el.style.willChange = "opacity";
            el.style.transition = "none";
        }
        el.style.opacity = String(opacity);
    }

    private clearStyles() {
        for (const el of this.moved) {
            el.style.transform = "";
            el.style.opacity = "";
            el.style.willChange = "";
            el.style.transition = "";
            el.style.backgroundColor = "";
            delete el.dataset.shown;
        }
        this.moved.clear();
        for (const side of [-1, 1] as const) {
            const pull = this.view.pull(side);
            pull?.classList.remove("is-ready");
            for (const half of Array.from(pull?.querySelectorAll<HTMLElement>(".mt-sb-ring-half > i") ?? [])) {
                half.style.transform = "";
            }
        }
    }

    private drawLibrary(look: SwipeLook, offset: number, ctx: SwipeCtx) {
        const lib = this.view.library();
        if (lib == null) {
            return;
        }
        // Leaving it follows the fingers across its width; the rubber band past its end stays a few pixels (#1261).
        const scale = offset > 0 ? lib.getBoundingClientRect().width / Math.max(1, ctx.width) : 1;
        const shown = Math.max(0, offset);
        this.move(lib, `translate3d(${look.pageX * scale}px, 0, 0)`, 1 - Math.min(1, shown / ctx.width) * 0.7);
    }

    private drawSidebar(look: SwipeLook, g: Gesture) {
        this.move(this.view.page(), `translate3d(${look.pageX}px, 0, 0)`);
        for (const side of [-1, 1] as const) {
            const ghost = this.view.ghost(side);
            if (look.neighbour?.side === side) {
                this.move(ghost, `translate3d(${look.neighbour.x}px, 0, 0)`);
            } else if (this.moved.has(ghost)) {
                this.move(ghost, `translate3d(${side * g.ctx.width}px, 0, 0)`);
            }
        }
        const tint = this.view.tint();
        if (tint != null) {
            const colour =
                look.neighbour == null ? "" : look.neighbour.side < 0 ? tint.dataset.prev : tint.dataset.next;
            // The browser normalises the colour it reads back: compare with the one written, or each frame rewrites it.
            if (colour && tint.dataset.shown !== colour) {
                tint.dataset.shown = colour;
                tint.style.backgroundColor = colour;
            }
            this.fade(tint, colour ? look.tint : 0);
        }
        for (const side of [-1, 1] as const) {
            const ring = look.ring?.side === side ? look.ring : null;
            const pull = this.view.pull(side);
            const shadow = this.view.shadow(side);
            if (ring == null) {
                if (this.moved.has(pull)) {
                    this.move(pull, "translateY(-50%) scale(0.6)", 0);
                    pull.classList.remove("is-ready");
                }
                if (this.moved.has(shadow)) {
                    this.fade(shadow, 0);
                }
                continue;
            }
            const p = ring.progress;
            this.move(pull, `translateY(-50%) scale(${ring.ready ? 1.08 : 0.6 + 0.4 * p})`, Math.min(1, p * 2.5));
            pull?.classList.toggle("is-ready", ring.ready);
            const turns = ringTurns(p);
            const [right, left] = Array.from(pull?.querySelectorAll<HTMLElement>(".mt-sb-ring-half > i") ?? []);
            if (right != null) {
                right.style.transform = `rotate(${turns.right}deg)`;
            }
            if (left != null) {
                left.style.transform = `rotate(${turns.left}deg)`;
            }
            this.fade(shadow, look.shadow);
        }
    }
}

// The controller of this view's sidebar, for the browser panels' forwarded wheel (their page's events never reach
// this document).
let current: SidebarSwipeController = null;

export function setCurrentSwipe(controller: SidebarSwipeController) {
    current = controller;
}

export function feedForwardedWheel(dx: number, dy: number) {
    current?.feedForwarded(dx, dy);
}

// A browser panel's page sends the sideways wheel it cannot use (emain/preload-webview.ts).
export function attachSwipeWheel(webview: WebviewTag): () => void {
    const onMessage = (e: Electron.IpcMessageEvent) => {
        if (e.channel !== SwipeWheelChannel) {
            return;
        }
        const msg = e.args?.[0] as SwipeWheelMessage;
        if (!Number.isFinite(msg?.dx) || !Number.isFinite(msg?.dy)) {
            return;
        }
        feedForwardedWheel(msg.dx, msg.dy);
    };
    webview.addEventListener("ipc-message", onMessage);
    return () => webview.removeEventListener("ipc-message", onMessage);
}
