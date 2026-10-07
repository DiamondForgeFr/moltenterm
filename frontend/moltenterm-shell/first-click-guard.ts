// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wave swallows the click that brings a deactivated macOS window back to the front (frontend/app/app.tsx). The window
// also gets a `focus` event whenever the user clicks the host page while a <webview> (the browser panel's page) holds
// the focus: that is no activation, and swallowing the click there made a click on the panel's tabs and buttons do
// nothing every other time (#334). The webview's own `blur` only follows that window `focus`, so the guard keeps
// whether a webview holds the focus instead of reading it when the window focus arrives.

export const FirstClickWindowMs = 50;

export type FirstClickGuard = {
    noteWebviewFocus: (focused: boolean) => void;
    noteWindowFocus: (now: number) => void;
    swallowsMouseDown: (now: number) => boolean;
};

export function makeFirstClickGuard(): FirstClickGuard {
    let webviewFocused = false;
    let activatedAt: number = null;
    return {
        noteWebviewFocus: (focused) => {
            webviewFocused = focused;
        },
        noteWindowFocus: (now) => {
            activatedAt = webviewFocused ? null : now;
        },
        swallowsMouseDown: (now) => activatedAt != null && now - activatedAt < FirstClickWindowMs,
    };
}
