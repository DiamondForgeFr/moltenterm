// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wave's tab bar ends a tab drag on the document's mouseup (#81). Chromium never delivers that mouseup when the button
// is released over a webview, outside the window, or at the end of a native drag of selected text (a tab name being
// edited): the tab then followed the pointer until the next click. A move without a pressed button means the release
// was missed.
export function checkTabDragReleased(event: Pick<MouseEvent, "buttons">): boolean {
    return event.buttons === 0;
}
