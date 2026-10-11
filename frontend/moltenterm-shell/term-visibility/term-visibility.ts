// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A terminal shown again must display its current content without a manual resize (#290). The decisions are pure and
// live here; termwrap.ts applies them. Two rules: the PTY never learns a size the user did not choose (a pane that is
// hidden, or measures nothing, keeps the size it had until it is visible with a real one), and a terminal that becomes
// visible, or whose renderer was replaced, is repainted in full.

// The renderer keeps a WebGL context only while the GPU hands it back; past this many losses in a window, the DOM
// renderer is the stable choice.
export const WebglLossWindowMs = 60 * 1000;
export const WebglMaxLossesInWindow = 2;

// The second repaint of a show runs after the compositor has re-attached the view (#223 hides and shows a view that
// sat off-screen for a while), which can be a few frames after the page reports visible.
export const ShowRepaintFollowUpMs = 300;

export type ResizeInput = {
    hidden: boolean;
    hasSized: boolean;
    elemWidth: number;
    elemHeight: number;
    proposedCols: number;
    proposedRows: number;
    curCols: number;
    curRows: number;
};

export type ResizeDecision = "none" | "apply" | "defer" | "skip";

// "skip": the pane measures nothing or the fit has no size to propose. "defer": a hidden view that already has a size
// keeps it, and applies the new one once visible. "none": nothing changed. The first fit of a hidden view is applied:
// a view rendered off-screen before it is shown (#68) must start its PTY at the size it will have.
export function decideResize(input: ResizeInput): ResizeDecision {
    if (input.elemWidth <= 0 || input.elemHeight <= 0) {
        return "skip";
    }
    if (!Number.isFinite(input.proposedCols) || !Number.isFinite(input.proposedRows)) {
        return "skip";
    }
    if (input.proposedCols <= 0 || input.proposedRows <= 0) {
        return "skip";
    }
    if (input.proposedCols === input.curCols && input.proposedRows === input.curRows) {
        return "none";
    }
    if (input.hidden && input.hasSized) {
        return "defer";
    }
    return "apply";
}

export type WebglLossRecovery = {
    action: "recreate" | "dom";
    losses: number[];
};

export function decideWebglLossRecovery(
    previousLosses: number[],
    now: number,
    windowMs = WebglLossWindowMs,
    maxLosses = WebglMaxLossesInWindow
): WebglLossRecovery {
    const losses = (previousLosses ?? []).filter((ts) => now - ts < windowMs);
    losses.push(now);
    return { action: losses.length > maxLosses ? "dom" : "recreate", losses };
}

// A terminal in a hidden tab view gives its WebGL buffers back (#454, FR-PERF-008): Chromium keeps a hidden view's
// last frame, and with it the GPU memory of its tiles, but a terminal's WebGL drawing buffers (about 20 MB each at
// full window size on a Retina display) are only needed to draw. After this long hidden, the terminal drops its WebGL
// renderer (xterm's DOM renderer stands in, drawing nothing while hidden) and gets a new one as it is shown, before
// its first frame, then is repainted in full as above. A fresh WebGL renderer made while hidden would allocate its
// buffers at once, so it is not made until then. The delay keeps quick switches back and forth from rebuilding
// renderers.
export const HiddenWebglReleaseMs = 10 * 1000;

export type HiddenWebglInput = {
    budgetEnabled: boolean;
    hidden: boolean;
    hasWebgl: boolean;
    disposed: boolean;
};

// The setting moltenterm:tabviewbudget set to false restores the previous behaviour.
export function shouldReleaseHiddenWebgl(input: HiddenWebglInput): boolean {
    return input.budgetEnabled && input.hidden && input.hasWebgl && !input.disposed;
}
