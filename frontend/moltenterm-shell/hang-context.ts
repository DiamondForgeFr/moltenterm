// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the page last asked of wavesrv (#849): a long task or a hang report names it, since a frozen page cannot say
// what it was doing. Shared by the renderer and Electron main (wos.ts runs in both); nothing here touches the DOM.

export type LastCall = { name: string; at: number };

export const HangContext = {
    rpc: null as LastCall,
    service: null as LastCall,
};

export function noteRpc(command: string) {
    HangContext.rpc = { name: command, at: Date.now() };
}

export function noteBackendCall(name: string) {
    HangContext.service = { name, at: Date.now() };
}

export function describeLastCall(call: LastCall, now: number): string {
    if (call == null) {
        return "none";
    }
    return `${call.name} (${Math.max(0, now - call.at)} ms before)`;
}
