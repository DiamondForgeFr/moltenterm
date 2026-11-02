// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The keys of a focused web page that the shortcut overlay needs (FR-SHELL-090, DS-SHELL-129): holding ⌘ over a page
// shows it too, and a chord or Escape closes it. A page's keys never reach the window's document, so Electron main
// sends a notice of the modifier keys, of the keys pressed with ⌘, Alt or Ctrl, and of Escape. Plain typing is never
// sent, and the page still receives every key: the notice only informs.

export const KeyNoticeChannel = "moltenterm-key-notice";

const NoticeModifiers = ["Meta", "Alt", "Control", "Shift", "OS", "AltGraph"];

export function isKeyNotice(e: WaveKeyboardEvent): boolean {
    if (e == null) {
        return false;
    }
    if (NoticeModifiers.includes(e.key)) {
        return e.type === "keydown" || e.type === "keyup";
    }
    if (e.type !== "keydown") {
        return false;
    }
    return e.key === "Escape" || !!e.meta || !!e.alt || !!e.control;
}

export function sendKeyNotice(wc: Electron.WebContents, e: WaveKeyboardEvent) {
    if (!isKeyNotice(e) || wc == null || wc.isDestroyed()) {
        return;
    }
    wc.send(KeyNoticeChannel, e);
}
