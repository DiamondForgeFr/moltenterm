// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The page side of "taking over is explicit" (#971, FR-BRW-008): in a page an agent drives, the user's click or key
// never reaches the page. emain holds back what its native observers see (before-mouse-event, before-input-event);
// this gate, run by the panel page's preload (emain/preload-webview.ts) before any listener of the page, covers the
// input those observers do not see. For each press or key down it asks emain, synchronously, whether the input is the
// agent's own (claimed by sequence, emain/moltenterm-browseragent-policy.ts); a user's press is held back with the rest of
// its gesture (mousedown, mouseup, click…), a user's key with its keypress and keyup. Wheel and moves stay free.

// The press and key reports emain matches against what the agent dispatched: a button and a point, or a key, never the
// text of a field.
export type InputReport =
    | { type: "mousedown"; button: number; x: number; y: number }
    | { type: "keydown"; key: string; code: string };

// Answers whether the input may reach the page: true for the agent's own input and for a page under no agent's control.
export type InputAsk = (report: InputReport) => boolean;

type GateEvent = {
    type: string;
    isTrusted: boolean;
    button?: number;
    clientX?: number;
    clientY?: number;
    key?: string;
    code?: string;
    preventDefault: () => void;
    stopImmediatePropagation: () => void;
};

// The events of a press the user made, held back once the press is.
const GestureEvents = new Set(["mousedown", "mouseup", "pointerup", "click", "dblclick", "auxclick", "contextmenu"]);

export const GateEventTypes = ["pointerdown", "keydown", "keypress", "keyup", ...GestureEvents];

export class WebviewInputGate {
    ask: InputAsk;
    // The current press is the user's and is held back, until the next press.
    gestureHeld = false;
    // Keys whose key down was held back, by code: their keypress and keyup are held back too.
    heldKeys = new Set<string>();

    constructor(ask: InputAsk) {
        this.ask = ask;
    }

    // handle returns whether it held the event back.
    handle(event: GateEvent): boolean {
        if (!event.isTrusted) {
            return false;
        }
        if (event.type === "pointerdown") {
            this.gestureHeld = !this.ask({
                type: "mousedown",
                button: event.button ?? 0,
                x: event.clientX ?? -1,
                y: event.clientY ?? -1,
            });
            return this.holdIf(event, this.gestureHeld);
        }
        if (GestureEvents.has(event.type)) {
            return this.holdIf(event, this.gestureHeld);
        }
        const code = String(event.code ?? "") || String(event.key ?? "");
        if (event.type === "keydown") {
            const held = !this.ask({ type: "keydown", key: String(event.key ?? ""), code: String(event.code ?? "") });
            if (held) {
                this.heldKeys.add(code);
            } else {
                this.heldKeys.delete(code);
            }
            return this.holdIf(event, held);
        }
        if (event.type === "keypress") {
            return this.holdIf(event, this.heldKeys.has(code));
        }
        if (event.type === "keyup") {
            const held = this.heldKeys.delete(code);
            return this.holdIf(event, held);
        }
        return false;
    }

    holdIf(event: GateEvent, hold: boolean): boolean {
        if (!hold) {
            return false;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
    }
}
