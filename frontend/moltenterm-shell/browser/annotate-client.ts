// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the annotate mode asks of the app: the capture of the page, wavesrv's preview, copy and send
// (pkg/molten/mission/annotate.go, answered to windows only), and the clipboard.

import { getApi } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "../mission/mission-client";
import { AnnotateCommand, type AnnotateRequest, type AnnotateResult } from "./annotate-model";

const AnnotateRpcTimeoutMs = 40000;
// A capture is a PNG data URL: anything shorter holds no picture.
const MinCaptureChars = 200;

export function callAnnotate(req: AnnotateRequest): Promise<AnnotateResult> {
    return TabRpcClient.wshRpcCall(AnnotateCommand, req, { route: MissionRouteId, timeout: AnnotateRpcTimeoutMs });
}

// settlePaint: the popover or button that started the mode is gone from the screen before the capture is taken. Two
// frames suffice; a hidden window draws none, so a short delay bounds the wait.
export function settlePaint(maxMs = 120): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, maxMs);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                clearTimeout(timer);
                resolve();
            })
        );
    });
}

function validCapture(url: unknown): string {
    return typeof url === "string" && url.startsWith("data:image/") && url.length > MinCaptureChars ? url : "";
}

// capturePage: the picture of what the window shows in a rectangle given in the page's own pixels; "" when the window
// cannot take one. The frame of the main process is in display units, which the window's zoom scales.
export async function capturePage(rect: { left: number; top: number; width: number; height: number }): Promise<string> {
    const api = getApi();
    if (api?.captureScreenshot == null || !(rect.width > 0) || !(rect.height > 0)) {
        return "";
    }
    const zoom = api.getZoomFactor?.() || 1;
    return validCapture(
        await api.captureScreenshot({
            x: Math.round(rect.left * zoom),
            y: Math.round(rect.top * zoom),
            width: Math.max(1, Math.round(rect.width * zoom)),
            height: Math.max(1, Math.round(rect.height * zoom)),
        })
    );
}

// takeCapture: the page's own picture first, which holds nothing the window draws over it (the layer, a popover, a
// toast, the find bar); else, when the page cannot give one, the window's picture of the panel's area, which may.
export async function takeCapture(
    page: () => Promise<string>,
    window: () => Promise<string>
): Promise<{ url: string; own: boolean }> {
    try {
        const own = validCapture(await page?.());
        if (own) {
            return { url: own, own: true };
        }
    } catch {
        // The page could not be captured: the window's picture follows.
    }
    try {
        return { url: validCapture(await window()), own: false };
    } catch {
        return { url: "", own: false };
    }
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
