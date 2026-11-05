// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Event subscriptions after a websocket reconnect (#1949). wavesrv accepts a window's subscription to its objects and
// to MoltenTerm's events only from a route bound on the window's link (metaguard.CallerOf, #662, #1821). The router
// binds a route announce before it reads the link's next message (pkg/wshutil/moltenterm_announceorder.go), so the
// subscriptions sent right after the announces pass. What was published while the link was down never came, though:
// the stores that keep a copy of wavesrv's state (the agent states) read it again once the window is subscribed.

type ResubscribedListener = () => void;

const ResubscribedListeners = new Set<ResubscribedListener>();

// onEventsResubscribed is told each time the window followed its events again after a reconnect.
export function onEventsResubscribed(fn: ResubscribedListener): () => void {
    ResubscribedListeners.add(fn);
    return () => {
        ResubscribedListeners.delete(fn);
    };
}

// reconnectHandler is the reconnect handler of a websocket client: the routes are announced again first, then the
// subscriptions, then the stores read wavesrv's state again.
export function reconnectHandler(reannounce: () => void, resubscribe: () => void): () => void {
    return () => {
        reannounce();
        resubscribe();
        console.log("ws reconnect: routes announced, events subscribed again");
        for (const fn of [...ResubscribedListeners]) {
            try {
                fn();
            } catch (e) {
                console.log("ws reconnect: a resubscribe listener failed", e);
            }
        }
    };
}
