// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// An agent's click must not move the window's keyboard focus (#971, FR-BRW-008). A mouse press the agent sends to a page
// gives its webview the window's focus, as a real click does; the user, still typing to the agent in the terminal, would
// then type into the page. emain says when an agent's press starts and when it has settled
// (emain/moltenterm-browseragent.ts, AgentPressChannel): the element that had the focus at the start gets it back at the
// end if the webview took it, and the panel does not take the block focus meanwhile. The webview does not always fire a
// focus event (a window in the background), so the end of the press checks the active element itself.
// emain also says when it held back the user's own click or key in such a page, for the bar's Take over hint.

type FocusTarget = { isConnected?: boolean; focus: () => void };

type FocusDoc = {
    activeElement: unknown;
    querySelector: (selector: string) => unknown;
};

export class AgentPressTracker {
    pending = new Map<number, number>();
    // The element that had the window's focus when the agent's press started, per webview.
    before = new Map<number, FocusTarget>();

    note(webContentsId: number, pressing: boolean, doc?: FocusDoc): void {
        if (!Number.isInteger(webContentsId)) {
            return;
        }
        const count = (this.pending.get(webContentsId) ?? 0) + (pressing ? 1 : -1);
        if (pressing && count === 1 && doc != null) {
            this.before.set(webContentsId, doc.activeElement as FocusTarget);
        }
        if (count > 0) {
            this.pending.set(webContentsId, count);
            return;
        }
        this.pending.delete(webContentsId);
        const previous = this.before.get(webContentsId);
        this.before.delete(webContentsId);
        if (doc == null) {
            return;
        }
        const webview = doc.querySelector(`webview[data-webcontentsid="${webContentsId}"]`);
        if (webview == null || doc.activeElement !== webview) {
            return;
        }
        if (previous != null && previous !== webview && previous.isConnected !== false) {
            previous.focus();
        }
    }

    pressing(webContentsId: number): boolean {
        return (this.pending.get(webContentsId) ?? 0) > 0;
    }
}

export const agentPresses = new AgentPressTracker();

// keepUserFocus gives the focus back to the element the webview took it from, when an agent's press took it; it says
// whether it did, so the panel does not take the block focus either.
export function keepUserFocus(
    webContentsId: number,
    webview: { blur: () => void },
    previous: FocusTarget,
    tracker: AgentPressTracker = agentPresses
): boolean {
    if (!tracker.pressing(webContentsId)) {
        return false;
    }
    if (previous != null && previous !== (webview as unknown) && previous.isConnected !== false) {
        previous.focus();
        return true;
    }
    webview.blur();
    return true;
}

export type AgentPressApi = {
    onMoltentermAgentPress?: (callback: (webContentsId: number, pressing: boolean) => void) => () => void;
    onMoltentermAgentInputHeld?: (callback: (webContentsId: number) => void) => () => void;
};

// What each webview does when emain held back the user's click or key in its page (the bar's hint, #971).
const heldHandlers = new Map<number, () => void>();

let listening = false;

export function listenAgentPresses(api: AgentPressApi): void {
    if (listening || api == null) {
        return;
    }
    listening = true;
    api.onMoltentermAgentPress?.((webContentsId, pressing) => agentPresses.note(webContentsId, pressing, document));
    api.onMoltentermAgentInputHeld?.((webContentsId) => heldHandlers.get(webContentsId)?.());
}

export function onInputHeld(webContentsId: number, handler: () => void): () => void {
    heldHandlers.set(webContentsId, handler);
    return () => {
        if (heldHandlers.get(webContentsId) === handler) {
            heldHandlers.delete(webContentsId);
        }
    };
}
