// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's end of the line to the comment overlay in a page (FR-BRW-017, #2422): messages out and in, requests matched
// by their number, and what a mark the page says it placed is checked for. A fake <webview>, synthetic pages.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestLink, type IpcEvent, type LinkedWebview, readPlaced } from "./annotate-guest-link";
import { type Anchor, AnnotateChannel, type FromGuest, MaxPathPoints, type ToGuest } from "./annotate-wire";

class FakeWebview implements LinkedWebview {
    sent: { channel: string; args: unknown[] }[] = [];
    listeners = new Map<string, Set<(e: any) => void>>();
    ready = true;

    send(channel: string, ...args: unknown[]) {
        if (!this.ready) {
            throw new Error(
                "the WebView must be attached to the DOM and the dom-ready event emitted before this method can be called"
            );
        }
        this.sent.push({ channel, args });
    }

    addEventListener(type: string, listener: (e: any) => void) {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
    }

    removeEventListener(type: string, listener: (e: any) => void) {
        this.listeners.get(type)?.delete(listener);
    }

    // What the page says: an ipc-message event.
    say(msg: unknown, channel = AnnotateChannel) {
        const event: IpcEvent = { channel, args: [msg] };
        for (const listener of this.listeners.get("ipc-message") ?? []) {
            listener(event);
        }
    }

    heard(): ToGuest[] {
        return this.sent.map((s) => s.args[0] as ToGuest);
    }
}

afterEach(() => vi.useRealTimers());

describe("the line to the page", () => {
    it("sends the panel's messages on the comment channel", () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        expect(link.send({ type: "tool", tool: "zone" })).toBe(true);
        expect(webview.sent).toEqual([{ channel: AnnotateChannel, args: [{ type: "tool", tool: "zone" }] }]);
    });

    it("says it could not send while the page cannot take a message yet", () => {
        const webview = new FakeWebview();
        webview.ready = false;
        expect(new GuestLink(webview).send({ type: "stop" })).toBe(false);
    });

    it("hands the page's messages to the layer, and nothing it did not send on the comment channel", () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        const heard: FromGuest[] = [];
        link.onMessage = (m) => heard.push(m);
        const detach = link.attach();
        webview.say({ type: "edit", id: 3 });
        webview.say({ type: "edit", id: 4 }, "moltenterm-carpet-wheel");
        webview.say(null);
        webview.say("edit");
        webview.say({ id: 5 });
        expect(heard).toEqual([{ type: "edit", id: 3 }]);
        detach();
        webview.say({ type: "edit", id: 6 });
        expect(heard).toHaveLength(1);
    });

    it("matches an answer to its request by number, whatever else the page says meanwhile", async () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        const heard: FromGuest[] = [];
        link.onMessage = (m) => heard.push(m);
        link.attach();
        const first = link.request((reqId) => ({ type: "prepare", reqId, id: 1 }));
        const second = link.request((reqId) => ({ type: "prepare", reqId, id: 2 }));
        const [a, b] = webview.heard() as { reqId: number }[];
        expect(a.reqId).not.toBe(b.reqId);
        webview.say({ type: "view", id: 2, box: { x: 0, y: 0, w: 1, h: 1 }, viewport: { w: 1, h: 1 } });
        webview.say({ type: "prepared", reqId: b.reqId, ok: true, tag: "second" });
        webview.say({ type: "prepared", reqId: a.reqId, ok: true, tag: "first" });
        expect(await first).toMatchObject({ tag: "first" });
        expect(await second).toMatchObject({ tag: "second" });
        expect(heard.map((m) => m.type)).toEqual(["view"]);
    });

    it("answers an answer nobody waits for as nothing, once", async () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        const heard: FromGuest[] = [];
        link.onMessage = (m) => heard.push(m);
        link.attach();
        const pending = link.request((reqId) => ({ type: "restore", reqId }));
        const { reqId } = webview.heard()[0] as { reqId: number };
        webview.say({ type: "restored", reqId });
        webview.say({ type: "restored", reqId });
        expect(await pending).toEqual({ type: "restored", reqId });
        expect(heard).toEqual([]);
    });

    it("ends a request the page never answers, by its bound, with null", async () => {
        vi.useFakeTimers();
        const link = new GuestLink(new FakeWebview());
        const pending = link.request((reqId) => ({ type: "prepare", reqId, id: 1 }), 5000);
        vi.advanceTimersByTime(5000);
        expect(await pending).toBeNull();
    });

    it("ends every request still waiting when the page starts to be left, and asks nothing of it until it is up again", async () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        link.attach();
        const first = link.request((reqId) => ({ type: "prepare", reqId, id: 1 }), 60_000);
        const second = link.request((reqId) => ({ type: "overview", reqId, slice: 0 }), 60_000);
        link.blocked = true;
        link.abortAll();
        expect(await first).toBeNull();
        expect(await second).toBeNull();
        const sent = webview.sent.length;
        expect(await link.request((reqId) => ({ type: "restore", reqId }))).toBeNull();
        expect(webview.sent).toHaveLength(sent);
        link.blocked = false;
        const again = link.request((reqId) => ({ type: "restore", reqId }), 60_000);
        const { reqId } = webview.heard()[webview.heard().length - 1] as { reqId: number };
        webview.say({ type: "restored", reqId });
        expect(await again).toEqual({ type: "restored", reqId });
    });

    it("ends the requests still waiting when the line is cut, and a request the page cannot take", async () => {
        const webview = new FakeWebview();
        const link = new GuestLink(webview);
        const detach = link.attach();
        const pending = link.request((reqId) => ({ type: "restore", reqId }), 60_000);
        detach();
        expect(await pending).toBeNull();
        webview.ready = false;
        expect(await link.request((reqId) => ({ type: "restore", reqId }))).toBeNull();
    });
});

const anchor = (change: Partial<Anchor> = {}): Anchor => ({
    box: { x: 10, y: 20, w: 30, h: 40 },
    selector: "main > h2",
    rel: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
    fixed: false,
    path: null,
    ...change,
});

const placed = (change: object = {}) => ({
    type: "placed",
    kind: "zone",
    address: "http://localhost:3000/a",
    anchor: anchor(),
    ...change,
});

describe("a mark the page says it placed", () => {
    it("is read as the comment's kind, anchor and page", () => {
        expect(readPlaced(placed())).toEqual({
            kind: "zone",
            address: "http://localhost:3000/a",
            anchor: anchor(),
        });
    });

    it("is refused for a kind it does not know, a box that is not numbers or has a negative size, or no address", () => {
        expect(readPlaced(placed({ kind: "star" }))).toBeNull();
        expect(readPlaced(placed({ anchor: anchor({ box: { x: NaN, y: 0, w: 1, h: 1 } }) }))).toBeNull();
        expect(readPlaced(placed({ anchor: anchor({ box: { x: 0, y: 0, w: -1, h: 1 } }) }))).toBeNull();
        expect(readPlaced(placed({ anchor: anchor({ box: null }) }))).toBeNull();
        expect(readPlaced(placed({ address: 3 }))).toBeNull();
        expect(readPlaced(placed({ anchor: null }))).toBeNull();
        expect(readPlaced(null)).toBeNull();
    });

    it("keeps no selector that is too long, nor one with no relative box, and leaves the page coordinates alone", () => {
        const long = readPlaced(placed({ anchor: anchor({ selector: "x".repeat(500) }) }));
        expect(long.anchor.selector).toBe("");
        expect(long.anchor.rel).toBeNull();
        expect(long.anchor.box).toEqual({ x: 10, y: 20, w: 30, h: 40 });
        const unrelated = readPlaced(placed({ anchor: anchor({ rel: null }) }));
        expect(unrelated.anchor.selector).toBe("");
    });

    it("keeps the flag of an element that moves with the viewport, only with a selector", () => {
        expect(readPlaced(placed({ anchor: anchor({ sticky: true }) })).anchor.sticky).toBe(true);
        expect(
            readPlaced(placed({ anchor: anchor({ sticky: "yes" as unknown as boolean }) })).anchor.sticky
        ).toBeUndefined();
        expect(readPlaced(placed({ anchor: anchor({ sticky: true, selector: "" }) })).anchor.sticky).toBeUndefined();
    });

    it("is refused for an outline that is not numbers or has too many points", () => {
        expect(readPlaced(placed({ kind: "freehand", anchor: anchor({ path: [0, 0, 1, 1] }) })).anchor.path).toEqual([
            0, 0, 1, 1,
        ]);
        expect(readPlaced(placed({ anchor: anchor({ path: [0, "a"] as unknown as number[] }) }))).toBeNull();
        expect(readPlaced(placed({ anchor: anchor({ path: new Array(MaxPathPoints * 2 + 2).fill(0.5) }) }))).toBeNull();
    });

    it("cuts an address the page made too long", () => {
        expect(readPlaced(placed({ address: `http://localhost/${"a".repeat(5000)}` })).address).toHaveLength(2048);
    });
});
