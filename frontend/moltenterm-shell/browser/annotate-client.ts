// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the comment mode asks of the app: wavesrv's preview, copy and send (pkg/molten/mission/annotate.go, answered to
// windows only), and the clipboard. The page itself is driven through annotate-guest-link.ts.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "../mission/mission-client";
import { AnnotateCommand, type AnnotateRequest, type AnnotateResult } from "./annotate-model";

const AnnotateRpcTimeoutMs = 40000;

export function callAnnotate(req: AnnotateRequest): Promise<AnnotateResult> {
    return TabRpcClient.wshRpcCall(AnnotateCommand, req, { route: MissionRouteId, timeout: AnnotateRpcTimeoutMs });
}

export type ClipboardLike = {
    write?: (items: unknown[]) => Promise<void>;
    writeText: (text: string) => Promise<void>;
};

// copyTextLater: the text reaches the clipboard once the answer is there. The write starts inside the click that asked
// for it, with a promise for the text, which the browser accepts where a write after a long wait for the answer would
// be refused (the document no longer holds the click); a browser that cannot do that waits, then writes.
export async function copyTextLater(
    text: Promise<string>,
    clipboard: ClipboardLike = navigator.clipboard,
    item: (type: string, blob: Promise<Blob>) => unknown = (type, blob) => new ClipboardItem({ [type]: blob })
): Promise<void> {
    if (clipboard.write != null && typeof ClipboardItem !== "undefined") {
        try {
            await clipboard.write([
                item(
                    "text/plain",
                    text.then((value) => new Blob([value], { type: "text/plain" }))
                ),
            ]);
            return;
        } catch {
            // Refused: the text is written once it is known, which also reports a failed answer.
        }
    }
    await clipboard.writeText(await text);
}
