// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// MOLTENTERM-PATCH (#805): explicit transport readiness and no credential-bearing redirects.

import type { WebSocket as NodeWebSocketType } from "ws";

let NodeWebSocket: typeof NodeWebSocketType = null;

const nodeWebSocketReady =
    typeof window === "undefined"
        ? // Necessary to avoid issues with Rollup: https://github.com/websockets/ws/issues/2057
          import("ws")
              .then((ws) => (NodeWebSocket = ws.default))
              .catch((e) => {
                  console.log("Error importing 'ws':", e);
              })
        : Promise.resolve();

export async function waitForNativeWebSocket(): Promise<void> {
    await nodeWebSocketReady;
    if (!NodeWebSocket) throw new Error("Native authenticated WebSocket transport is unavailable");
}

type ComboWebSocket = NodeWebSocketType | WebSocket;

function newWebSocket(url: string, headers: { [key: string]: string }): ComboWebSocket {
    if (NodeWebSocket) {
        return new NodeWebSocket(url, { headers, followRedirects: false });
    } else {
        return new WebSocket(url);
    }
}

export { newWebSocket };
export type { ComboWebSocket as WebSocket };
