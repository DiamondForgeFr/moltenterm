// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The lookalike-domain warning in Electron main (#2482, FR-BRW-024, DS-BRW-029). Every main-frame navigation of a
// webview guest, typed, clicked, redirected or made by an agent, passes session.webRequest.onBeforeRequest. One that goes
// to a domain imitating a known one is cancelled before any request leaves the computer, and the panel draws the warning:
// it asks main which navigation the guest was held for when the load fails with ERR_BLOCKED_BY_CLIENT. The developer's
// Continue records the domain in the application's own data folder (moltenterm-lookalike-store.ts). The decision itself is
// moltenterm-lookalike-gate.ts. A failure here never blocks a page: the navigation goes on.

import * as electron from "electron";
import * as path from "path";
import { LookalikeHold } from "../frontend/moltenterm-shell/browser/lookalike";
import { getWaveDataDir } from "./emain-platform";
import { setAgentNavigationHooks } from "./moltenterm-lookalike-agent";
import { LookalikeGate } from "./moltenterm-lookalike-gate";
import { LookalikeStore } from "./moltenterm-lookalike-store";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { liveWebContentsFromId } from "./moltenterm-webcontents-id";

// renderer to Electron main (application frame only): (bookmark addresses, pinned site addresses)
export const LookalikeKnownChannel = "moltenterm-lookalike-known";
// renderer to Electron main, invoked with the guest's web contents id: the navigation held for that guest, or null
export const LookalikeHeldChannel = "moltenterm-lookalike-held";
// renderer to Electron main (application frame only): (guest web contents id) the developer continues to the held domain
export const LookalikeContinueChannel = "moltenterm-lookalike-continue";

const LookalikeFolder = "lookalike";

let store: LookalikeStore = null;
let gate: LookalikeGate = null;
let agentProbe: (webContentsId: number) => boolean = () => false;
const hookedSessions = new WeakSet<electron.Session>();

function theGate(): LookalikeGate {
    if (gate == null) {
        store = new LookalikeStore(path.join(getWaveDataDir(), LookalikeFolder));
        gate = new LookalikeGate(store);
    }
    return gate;
}

// emain/moltenterm-browseragent.ts decides whether a guest is under an agent's control; this module does not import it.
export function setLookalikeAgentProbe(probe: (webContentsId: number) => boolean): void {
    agentProbe = probe;
}

function onBeforeRequest(
    details: electron.OnBeforeRequestListenerDetails,
    callback: (response: electron.CallbackResponse) => void
): void {
    try {
        const guest = details.resourceType === "mainFrame" ? liveWebContentsFromId(details.webContentsId) : null;
        if (guest == null || guest.getType() !== "webview") {
            callback({});
            return;
        }
        const hold = theGate().check(guest.id, details.url);
        if (hold != null) {
            console.log("lookalike: held a navigation");
        }
        callback(hold != null ? { cancel: true } : {});
    } catch (e) {
        console.log("lookalike: check failed, the navigation goes on", e instanceof Error ? e.message : String(e));
        callback({});
    }
}

function hookSession(session: electron.Session): void {
    if (session == null || hookedSessions.has(session)) {
        return;
    }
    hookedSessions.add(session);
    // Only main-frame navigations reach the listener: subresources never pay for it.
    session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"], types: ["mainFrame"] }, onBeforeRequest);
}

// The guest of a request from the window that holds it, or null.
function guestOf(
    event: electron.IpcMainEvent | electron.IpcMainInvokeEvent,
    webContentsId: unknown
): electron.WebContents {
    const guest = liveWebContentsFromId(webContentsId);
    if (guest == null || guest.getType() !== "webview" || guest.hostWebContents?.id !== event.sender.id) {
        return null;
    }
    return guest;
}

// A page the guest shows is the developer's visit, unless an agent is behind it.
export function observeLookalikeGuest(guest: electron.WebContents): void {
    const id = guest.id;
    guest.on("did-navigate", (_event, url) => theGate().noteCommitted(id, url, agentProbe(id)));
    guest.once("destroyed", () => gate?.forget(id));
}

// Before any window: every session, the default one and each partition created later, and the window's channels.
export function installMoltentermLookalike(): void {
    setAgentNavigationHooks({
        begin: (id) => theGate().beginAgentNavigation(id),
        end: (id) => theGate().endAgentNavigation(id),
        wasHeld: (id) => gate != null && gate.agentWasHeld(id),
    });
    hookSession(electron.session.defaultSession);
    electron.app.on("session-created", (session) => hookSession(session));
    electron.app.on("before-quit", () => store?.flush());
    onAppIpc(LookalikeKnownChannel, (_event, bookmarks: unknown, pinned: unknown) => {
        theGate().setKnown(bookmarks, pinned);
    });
    handleAppIpc(LookalikeHeldChannel, (event, webContentsId: unknown): LookalikeHold => {
        const guest = guestOf(event, webContentsId);
        return guest == null ? null : (gate?.holdOf(guest.id) ?? null);
    });
    onAppIpc(LookalikeContinueChannel, (event, webContentsId: unknown) => {
        const guest = guestOf(event, webContentsId);
        if (guest != null) {
            gate?.continueTo(guest.id);
        }
    });
}
