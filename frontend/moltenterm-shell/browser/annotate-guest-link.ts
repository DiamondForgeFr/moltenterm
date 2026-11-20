// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's end of the line to the comment overlay in a page (FR-BRW-017, #2422): messages out with webview.send, the
// page's messages in with its ipc-message event, and the answers to a request matched by their number. A request that
// is never answered (a page that hangs, one that navigated away) ends by the generous bound below, with null, so that
// nothing waits for ever; the bound only decides a failing run, never a passing one.

import type { Placed } from "./annotate-model";
import {
    type Anchor,
    AnnotateChannel,
    type Box,
    type FromGuest,
    type MarkKind,
    MaxPathPoints,
    type ToGuest,
} from "./annotate-wire";

export type IpcEvent = { channel: string; args: unknown[] };

// What the link needs of the page's <webview>.
export type LinkedWebview = {
    send(channel: string, ...args: unknown[]): void;
    addEventListener(type: string, listener: (e: any) => void): void;
    removeEventListener(type: string, listener: (e: any) => void): void;
};

export const RequestBoundMs = 30_000;

export class GuestLink {
    webview: LinkedWebview;
    nextReq = 1;
    waiting = new Map<number, { settle: (m: FromGuest) => void; timer: ReturnType<typeof setTimeout> }>();
    onMessage: (msg: FromGuest) => void = () => {};
    // While the page is being left (from its navigation starting to its next document being ready) nothing is asked of it:
    // a request would reach no overlay, and wait for its bound.
    blocked = false;

    constructor(webview: LinkedWebview) {
        this.webview = webview;
    }

    // abortAll: every request still waiting ends with null, as the page that would have answered is gone.
    abortAll(): void {
        for (const [reqId, wait] of this.waiting) {
            clearTimeout(wait.timer);
            this.waiting.delete(reqId);
            wait.settle(null);
        }
    }

    // attach: starts reading the page's messages; the returned function stops, and ends every request still waiting.
    attach(): () => void {
        const listener = (e: IpcEvent) => this.receive(e);
        this.webview.addEventListener("ipc-message", listener);
        return () => {
            this.webview.removeEventListener("ipc-message", listener);
            this.abortAll();
        };
    }

    receive(e: IpcEvent): void {
        if (e?.channel !== AnnotateChannel) {
            return;
        }
        const msg = e.args?.[0] as FromGuest;
        if (msg == null || typeof msg !== "object" || typeof msg.type !== "string") {
            return;
        }
        const reqId = (msg as { reqId?: unknown }).reqId;
        if (typeof reqId === "number") {
            const wait = this.waiting.get(reqId);
            if (wait != null) {
                clearTimeout(wait.timer);
                this.waiting.delete(reqId);
                wait.settle(msg);
            }
            return;
        }
        this.onMessage(msg);
    }

    // send: false when the page cannot take it yet (a <webview> throws before its first dom-ready).
    send(msg: ToGuest): boolean {
        try {
            this.webview.send(AnnotateChannel, msg);
            return true;
        } catch {
            return false;
        }
    }

    request<M extends FromGuest>(build: (reqId: number) => ToGuest, boundMs = RequestBoundMs): Promise<M> {
        const reqId = this.nextReq++;
        if (this.blocked) {
            return Promise.resolve(null);
        }
        return new Promise<M>((resolve) => {
            const settle = (m: FromGuest) => resolve(m as M);
            const timer = setTimeout(() => {
                this.waiting.delete(reqId);
                resolve(null);
            }, boundMs);
            this.waiting.set(reqId, { settle, timer });
            if (!this.send(build(reqId))) {
                clearTimeout(timer);
                this.waiting.delete(reqId);
                resolve(null);
            }
        });
    }
}

const Kinds: MarkKind[] = ["point", "zone", "freehand"];
const MaxSelectorChars = 400;
const MaxAddressChars = 2048;

function finite(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n);
}

export function readBox(box: unknown): Box {
    const b = box as Box;
    if (b == null || !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h) || b.w < 0 || b.h < 0) {
        return null;
    }
    return { x: b.x, y: b.y, w: b.w, h: b.h };
}

// readPlaced: a mark the page says it placed, checked: a page's own script cannot send this message, but its words (the
// selector) come from the page's content, so every field is read as data, bounded.
export function readPlaced(msg: unknown): Placed {
    const m = msg as { kind?: unknown; address?: unknown; anchor?: Partial<Anchor> };
    const a = m?.anchor;
    if (a == null || !Kinds.includes(m.kind as MarkKind) || typeof m.address !== "string") {
        return null;
    }
    const box = readBox(a.box);
    if (box == null || typeof a.selector !== "string") {
        return null;
    }
    let rel: Box = null;
    if (a.rel != null) {
        const r = a.rel as Box;
        if (![r.x, r.y, r.w, r.h].every(finite)) {
            return null;
        }
        rel = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    let path: number[] = null;
    if (Array.isArray(a.path)) {
        if (a.path.length > MaxPathPoints * 2 || !a.path.every(finite)) {
            return null;
        }
        path = a.path.slice();
    }
    const selector = a.selector.length > MaxSelectorChars || rel == null ? "" : a.selector;
    const anchor: Anchor = { box, selector, rel: selector === "" ? null : rel, fixed: !!a.fixed, path };
    if (a.sticky === true && selector !== "") {
        anchor.sticky = true;
    }
    return { kind: m.kind as MarkKind, address: m.address.slice(0, MaxAddressChars), anchor };
}
