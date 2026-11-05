// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Event subscriptions after a websocket reconnect (#1949). wavesrv accepts a window's subscription to its objects and
// to MoltenTerm's events only from a route bound on the window's link (metaguard.CallerOf, #662, #1821). Wave sent the
// route announces and the subscriptions back to back, and wavesrv runs each request on its own goroutine: when a
// subscription ran before its route was bound again, it was refused without an answer, and the window followed no
// event any more (a new agent pane stayed a plain Terminal, the tab missed its new panes) until it was reloaded.
// The subscriptions now wait for wavesrv's answer to the route announce, then the stores that keep a copy of wavesrv's
// state (the agent states) read it again: what was published while the link was down never came.

export const ResubscribeAnnounceTimeoutMs = 5000;

type ResubscribedListener = () => void;

const ResubscribedListeners = new Set<ResubscribedListener>();

// onEventsResubscribed is told each time the window followed its events again after a reconnect.
export function onEventsResubscribed(fn: ResubscribedListener): () => void {
    ResubscribedListeners.add(fn);
    return () => {
        ResubscribedListeners.delete(fn);
    };
}

type AnnouncingClient = { wshRpcCall(command: string, data: any, opts: RpcOpts): Promise<any> };

// routeFirstReconnectHandler is the reconnect handler of a websocket client: the routes are announced again, then the
// client's own route once more with an answer (binding a route twice is harmless), and only then the subscriptions.
export function routeFirstReconnectHandler(
    client: AnnouncingClient,
    reannounce: () => void,
    resubscribe: () => void
): () => void {
    return () => {
        reannounce();
        void resubscribeAfterRoute(
            () =>
                client.wshRpcCall("routeannounce", null, { route: "$control", timeout: ResubscribeAnnounceTimeoutMs }),
            resubscribe
        );
    };
}

// resubscribeAfterRoute subscribes again once announce (the route announce, with an answer) is done. A failed or late
// announce still resubscribes: the old order is the best left.
export async function resubscribeAfterRoute(announce: () => Promise<unknown>, resubscribe: () => void): Promise<void> {
    try {
        await announce();
    } catch (e) {
        console.log("ws reconnect: route announce failed, subscribing anyway", e);
    }
    resubscribe();
    for (const fn of [...ResubscribedListeners]) {
        try {
            fn();
        } catch (e) {
            console.log("ws reconnect: a resubscribe listener failed", e);
        }
    }
}
