// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { ipcMain } from "electron";

type CallerEvent = Pick<Electron.IpcMainEvent, "sender" | "senderFrame">;
type Authorize = (event: CallerEvent) => boolean;
type Listener = (event: Electron.IpcMainEvent, ...args: any[]) => void;
type Handler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;
type Registration = Pick<Electron.IpcMain, "on" | "removeListener" | "handle">;

export const IpcDeniedMessage = "IPC caller not authorized";

// The backend caller boundary supplies its one registry. Until then every call is denied.
// Keeping this dependency explicit avoids platform -> IPC -> authkey -> platform initialization cycles.
let applicationAuthorizer: Authorize = () => false;
let configured = false;
export function configurePrivilegedIpc(authorize: Authorize): void {
    if (configured) throw new Error("IPC authorization already configured");
    applicationAuthorizer = authorize;
    configured = true;
}

export function createPrivilegedIpc(registration: Registration, authorize: Authorize) {
    const allowsApp = (event: CallerEvent): boolean => {
        try {
            return authorize(event);
        } catch {
            return false;
        }
    };
    const allowsGuest = (event: CallerEvent): boolean => {
        try {
            const guest = event.sender;
            if (guest.isDestroyed() || guest.getType() !== "webview" || event.senderFrame !== guest.mainFrame) {
                return false;
            }
            const host = guest.hostWebContents;
            return host != null && allowsApp({ sender: host, senderFrame: host.mainFrame });
        } catch {
            return false;
        }
    };
    const on = (channel: string, listener: Listener, allows: Authorize): (() => void) => {
        const guarded: Listener = (event, ...args) => {
            if (!allows(event)) {
                // Also answers sendSync: ignoring an unauthorized synchronous request would hang its renderer.
                event.returnValue = null;
                return;
            }
            return listener(event, ...args);
        };
        registration.on(channel, guarded);
        return () => registration.removeListener(channel, guarded);
    };
    return {
        allowsApp,
        onApp: (channel: string, listener: Listener) => on(channel, listener, allowsApp),
        // Only the documented native guest input signals may use this entry point. Their ownership and
        // payload-specific checks remain mandatory in the listener; this grants no general application API.
        onGuest: (channel: string, listener: Listener) => on(channel, listener, allowsGuest),
        handleApp: (channel: string, handler: Handler): void => {
            registration.handle(channel, (event, ...args) => {
                if (!allowsApp(event)) throw new Error(IpcDeniedMessage);
                return handler(event, ...args);
            });
        },
    };
}

const privilegedIpc = createPrivilegedIpc(
    {
        on: (channel, listener) => ipcMain.on(channel, listener),
        removeListener: (channel, listener) => ipcMain.removeListener(channel, listener),
        handle: (channel, handler) => ipcMain.handle(channel, handler),
    },
    (event) => applicationAuthorizer(event)
);
export const onAppIpc = privilegedIpc.onApp;
export const handleAppIpc = privilegedIpc.handleApp;
export const onGuestIpc = privilegedIpc.onGuest;
export const isAppIpcSender = privilegedIpc.allowsApp;
