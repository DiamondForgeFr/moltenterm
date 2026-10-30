// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ipcRenderer } from "electron";
// MOLTENTERM-PATCH (#676)
import {
    canScrollX,
    CarpetWheelChannel,
    CarpetWheelMessage,
    CarpetWheelState,
    CarpetWheelStateChannel,
    horizontalWheelDelta,
    routeHorizontalWheel,
} from "../frontend/moltenterm-shell/view360/carpet-wheel";
// MOLTENTERM-PATCH (#971)
import { GateEventTypes, WebviewInputGate } from "./moltenterm-webview-input-gate";

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

// MOLTENTERM-PATCH (#300, #302, #971): a click or key of the user in a page an agent drives is held back until the user
// takes over in the panel (emain/moltenterm-webview-input-gate.ts); emain answers that a page under no agent's control
// takes all input. Captured before the page's own listeners. emain tells the agent's own input from the user's by
// matching each report against the input it dispatched, so the report says which button and point, or which key: never
// the text of a field.
const moltentermInputGate = new WebviewInputGate(
    (report) => ipcRenderer.sendSync("moltenterm-webview-input", report) !== false
);
for (const type of GateEventTypes) {
    window.addEventListener(type, (event) => moltentermInputGate.handle(event as any), true);
}

// MOLTENTERM-PATCH (#676): in 360 view the page's wheel never reaches the host's carpet. The host says whether this
// panel lies on a scrollable carpet and has the focus; a horizontal scroll the panel should not keep is cancelled here
// and handed to the host. The blocking listener only exists while the panel is on the carpet, so pages elsewhere keep
// their scrolling off the main thread.
let moltentermCarpetWheel: CarpetWheelState = { onCarpet: false, focused: false };
function moltentermOnCarpetWheel(event: WheelEvent) {
    if (!event.isTrusted) {
        return;
    }
    const delta = horizontalWheelDelta(event);
    if (delta == null) {
        return;
    }
    const panelCanScroll = moltentermCarpetWheel.focused && canScrollX(event.target, delta);
    if (routeHorizontalWheel(moltentermCarpetWheel.focused, panelCanScroll) === "panel") {
        return;
    }
    event.preventDefault();
    const message: CarpetWheelMessage = { delta, deltaMode: event.deltaMode };
    ipcRenderer.sendToHost(CarpetWheelChannel, message);
}
ipcRenderer.on(CarpetWheelStateChannel, (_event, state: CarpetWheelState) => {
    const was = moltentermCarpetWheel.onCarpet;
    moltentermCarpetWheel = { onCarpet: !!state?.onCarpet, focused: !!state?.focused };
    if (moltentermCarpetWheel.onCarpet === was) {
        return;
    }
    if (moltentermCarpetWheel.onCarpet) {
        window.addEventListener("wheel", moltentermOnCarpetWheel, { capture: true, passive: false });
    } else {
        window.removeEventListener("wheel", moltentermOnCarpetWheel, { capture: true });
    }
});

console.log("loaded wave preload-webview.ts");
