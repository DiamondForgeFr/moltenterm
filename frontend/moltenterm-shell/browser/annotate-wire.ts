// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the web page panel and the overlay in its page say to each other in comment mode (FR-BRW-017, DS-BRW-024, #2422).
// The overlay is built inside the page's own document by the page's preload (emain/moltenterm-annotate-guest.ts) and
// the panel's layer drives it: both load this file, so it holds types and constants only, no code that needs a DOM.

// webview.send (panel to page) and ipcRenderer.sendToHost (page to panel) use the same channel.
export const AnnotateChannel = "moltenterm-annotate";

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

export type MarkKind = "point" | "zone" | "freehand";

// An anchor is where a mark is on the page: its box in page coordinates (from the document's top-left corner, so it
// does not depend on the scroll), the CSS selector of the element under it when there is one, and the box relative to
// that element, so the mark stays on its element when the page is resized or reflows (annotate-anchor.ts).
export type Anchor = {
    box: Box;
    // "" when no element could be named: the page coordinates are then all there is.
    selector: string;
    // The mark's box as fractions of the element's box when it was placed; null with no selector. For a fixed mark it
    // is the mark's centre as fractions of the element's box (w and h are 0).
    rel: Box;
    // A point marker keeps its size when its element's changes.
    fixed: boolean;
    // The element, or one around it, is fixed or sticky: it moves with the viewport, not with the page, so the mark is
    // read again on every scroll.
    sticky?: boolean;
    // A freehand outline: its points (x0, y0, x1, y1...) as fractions of the box.
    path: number[];
};

// A mark as the overlay draws it. n is its number in the list; active is the one whose comment is being edited.
export type MarkView = { id: number; n: number; kind: MarkKind; anchor: Anchor; active: boolean };

export type StartMessage = {
    type: "start";
    // The theme's action colour, read by the panel: the page cannot see it.
    color: string;
    tool: MarkKind;
    paused: boolean;
    marks: MarkView[];
    // The comment whose field is open (0: none), so a page that was reloaded reports where its mark is again.
    track?: number;
};

// Panel to page.
export type ToGuest =
    | StartMessage
    | { type: "tool"; tool: MarkKind }
    | { type: "pause"; paused: boolean }
    // While the pictures are taken the page takes no pointer, wheel or scrolling key from the developer.
    | { type: "lock"; locked: boolean }
    | { type: "marks"; marks: MarkView[] }
    // Scroll the page to a mark and flash it.
    | { type: "reveal"; id: number }
    // Report where a mark is, in the page's viewport, while the page scrolls or resizes (id 0: stop).
    | { type: "track"; id: number }
    // Hide the overlay, put a mark in view and say where it is, for the capture of its region.
    | { type: "prepare"; reqId: number; id: number }
    // slice -1: how the page is made; slice n: scroll to the n-th screen of the page, overlay hidden.
    | { type: "overview"; reqId: number; slice: number }
    // Show the overlay again and put the page back where the developer left it.
    | { type: "restore"; reqId: number }
    | { type: "stop" };

export type PlacedMessage = { type: "placed"; address: string; kind: MarkKind; anchor: Anchor };

export type PreparedMessage = {
    type: "prepared";
    reqId: number;
    ok: boolean;
    // All in the page's viewport, in CSS pixels.
    viewport: Size;
    box: Box;
    path: number[];
    scroll: Point;
    // false: the mark's element is gone (its selector names nothing any more); it stays where it was drawn.
    onElement?: boolean;
    // Why ok is false: the mark is not there (gone), or a scrolling area of the page clips it (clipped).
    reason?: "gone" | "clipped";
};

export type OverviewMessage = {
    type: "overview";
    reqId: number;
    ok: boolean;
    viewport: Size;
    scroll: Point;
    doc: Size;
    // The document scrolls as a whole (not an inner scroller) and is not taller than the panel allows.
    whole: boolean;
    // Every mark of the page, resolved, in page coordinates, to number them on the overview.
    marks: { id: number; n: number; kind: MarkKind; box: Box; path: number[] }[];
};

// Page to panel.
export type FromGuest =
    // The developer pressed on the page with a tool: a comment field that is open is validated, as a click elsewhere does.
    | { type: "press" }
    | PlacedMessage
    | { type: "edit"; id: number }
    | { type: "view"; id: number; box: Box; viewport: Size }
    | { type: "key"; key: "Escape" }
    // The comments whose element the page no longer has (sent when the set changes).
    | { type: "found"; missing: number[] }
    | PreparedMessage
    | OverviewMessage
    | { type: "restored"; reqId: number };

export const MaxMarks = 20;
// A drag shorter than this, in pixels, in either direction is a click.
export const MinMarkPx = 8;
// The size of the marker a click draws where no element is a fit for it.
export const PointMarkPx = 32;
// A freehand outline keeps at most this many points.
export const MaxPathPoints = 120;
// A page taller than this many screens has no overview.
export const MaxOverviewScreens = 12;
