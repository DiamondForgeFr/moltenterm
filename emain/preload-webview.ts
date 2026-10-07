// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ipcRenderer } from "electron";

document.addEventListener("contextmenu", (event) => {
    console.log("contextmenu event", event);
    if (event.target == null) {
        return;
    }
    const targetElement = event.target as HTMLElement;
    // Check if the right-click is on an image
    if (targetElement.tagName === "IMG") {
        setTimeout(() => {
            if (event.defaultPrevented) {
                return;
            }
            event.preventDefault();
            const imgElem = targetElement as HTMLImageElement;
            const imageUrl = imgElem.src;
            ipcRenderer.send("webview-image-contextmenu", { src: imageUrl });
        }, 50);
        return;
    }
    // do nothing
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
