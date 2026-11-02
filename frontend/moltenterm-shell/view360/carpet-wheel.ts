// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Who gets a horizontal scroll in 360 view (FR-SHELL-065, #676): the carpet, or the panel under the pointer. Shared by
// the carpet's own wheel listener and by the browser panels' guest pages (emain/preload-webview.ts), whose wheel never
// reaches the host DOM: keep this file free of app imports.

export const CarpetWheelStateChannel = "moltenterm-carpet-wheel-state";
export const CarpetWheelChannel = "moltenterm-carpet-wheel";

const LinePx = 16;

// What a guest page needs to route its wheel; sent by the host whenever it changes.
export type CarpetWheelState = {
    // The panel lies on a carpet that can scroll (not in the fixed zone, 360 view on).
    onCarpet: boolean;
    focused: boolean;
};

// A guest page's horizontal scroll handed to the carpet, in the event's own units.
export type CarpetWheelMessage = {
    delta: number;
    deltaMode: number;
    // When the event happened, in epoch ms (timeOrigin + timeStamp): the host reads the gesture's pauses from it, as
    // the message may wait behind a busy thread (#1466).
    at?: number;
};

// The guest event's time on the host page's clock, or now when the message carries none.
export function hostWheelTime(msg: CarpetWheelMessage, timeOrigin: number, now: number): number {
    const at = msg?.at;
    if (typeof at !== "number" || !Number.isFinite(at)) {
        return now;
    }
    // Clocks of two processes: never in the future.
    return Math.min(now, at - timeOrigin);
}

export type WheelRoute = "carpet" | "panel";

type WheelLike = { deltaX: number; deltaY: number; shiftKey: boolean };

// The horizontal delta of a wheel event, or null when the gesture is vertical (it always stays with the panel).
// Shift + a vertical wheel scrolls sideways.
export function horizontalWheelDelta(e: WheelLike): number {
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!horizontal && !e.shiftKey) {
        return null;
    }
    const delta = horizontal ? e.deltaX : e.deltaY || e.deltaX;
    return delta === 0 ? null : delta;
}

export function wheelDeltaPx(delta: number, deltaMode: number, pagePx: number): number {
    const unit = deltaMode === 1 ? LinePx : deltaMode === 2 ? pagePx : 1;
    return delta * unit;
}

// An unfocused panel never keeps a horizontal scroll: the developer is moving along the carpet. A focused one keeps it
// while it can still scroll that way, and hands it over at its edge.
export function routeHorizontalWheel(focused: boolean, panelCanScroll: boolean): WheelRoute {
    return focused && panelCanScroll ? "panel" : "carpet";
}

// Room left in a scroller in the delta's direction. scrollLeft runs from -max to 0 in a right-to-left box.
export function hasRoomX(
    scrollLeft: number,
    scrollWidth: number,
    clientWidth: number,
    rtl: boolean,
    delta: number
): boolean {
    const max = scrollWidth - clientWidth;
    if (max <= 1) {
        return false;
    }
    const offset = rtl ? scrollLeft + max : scrollLeft;
    return delta > 0 ? offset < max - 1 : offset > 1;
}

// Monaco draws its own scrollbars over an overflow: hidden box: its horizontal slider tells the position.
function monacoRoomX(el: Element, delta: number): boolean {
    const track = el.querySelector(":scope > .scrollbar.horizontal") as HTMLElement;
    const slider = track?.querySelector(":scope > .slider") as HTMLElement;
    if (track == null || slider == null) {
        return false;
    }
    const trackWidth = track.clientWidth;
    const left = slider.offsetLeft;
    const width = slider.offsetWidth;
    if (width <= 0 || width >= trackWidth - 1) {
        return false;
    }
    return delta > 0 ? left + width < trackWidth - 1 : left > 1;
}

// Whether something between the event's target and stopAt (included) can still scroll sideways in the delta's
// direction. The document's own scroller counts unless the page hides its horizontal overflow.
export function canScrollX(target: EventTarget, delta: number, stopAt: Element = null): boolean {
    // Not instanceof Element: the unit tests run without a DOM and walk fake elements.
    let el = (target as Node)?.nodeType === 1 ? (target as Element) : null;
    const doc = el?.ownerDocument;
    const scrolling = doc?.scrollingElement;
    while (el != null) {
        if (el.classList.contains("monaco-scrollable-element") && monacoRoomX(el, delta)) {
            return true;
        }
        const style = doc.defaultView.getComputedStyle(el);
        const overflow = style.overflowX;
        const scrollable =
            el === scrolling
                ? overflow !== "hidden" && overflow !== "clip"
                : overflow === "auto" || overflow === "scroll" || overflow === "overlay";
        if (scrollable && hasRoomX(el.scrollLeft, el.scrollWidth, el.clientWidth, style.direction === "rtl", delta)) {
            return true;
        }
        if (el === stopAt) {
            return false;
        }
        el = el.parentElement;
    }
    return false;
}
