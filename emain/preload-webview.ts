// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ipcRenderer } from "electron";

// MOLTENTERM-PATCH (#371): a single trusted request after the page can suppress its own menu.
document.addEventListener("contextmenu", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const element = event.target;
    const image = element.closest("img") as HTMLImageElement;
    const link = element.closest("a[href]") as HTMLAnchorElement;
    const editable = element.closest("input,textarea,[contenteditable]:not([contenteditable='false'])");
    setTimeout(() => {
        if (event.defaultPrevented) return;
        ipcRenderer.send("moltenterm-contextmenu-guest-request", {
            x: event.clientX,
            y: event.clientY,
            src: image?.currentSrc || image?.src,
            linkURL: link?.href,
            selectionText: window.getSelection()?.toString(),
            editable: !!editable,
        });
    }, 0);
});

document.addEventListener("mouseup", (event) => {
    // Mouse button 3 = back, button 4 = forward
    if (!event.isTrusted) {
        return;
    }
    if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        ipcRenderer.send("webview-mouse-navigate", event.button === 3 ? "back" : "forward");
    }
});

// MOLTENTERM-PATCH (#300, #302): a click or key of the user in a page an agent drives takes over (emain/moltenterm-browseragent.ts
// ignores it for pages under no agent's control). Captured before the page's own listeners. emain tells the agent's own
// input from the user's by matching each report against the input it dispatched, so the report says which button and
// point, or which key: never the text of a field.
function moltentermNoteInput(event: Event) {
    if (!event.isTrusted) {
        return;
    }
    if (event instanceof MouseEvent) {
        ipcRenderer.send("moltenterm-webview-input", {
            type: "mousedown",
            button: event.button,
            x: event.clientX,
            y: event.clientY,
        });
        return;
    }
    if (event instanceof KeyboardEvent) {
        ipcRenderer.send("moltenterm-webview-input", { type: "keydown", key: event.key, code: event.code });
    }
}
window.addEventListener("mousedown", moltentermNoteInput, true);
window.addEventListener("keydown", moltentermNoteInput, true);

console.log("loaded wave preload-webview.ts");
