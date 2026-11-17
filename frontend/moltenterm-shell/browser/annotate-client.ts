// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the annotate mode asks of the app: the capture of the page's panel, and wavesrv's preview, copy and send
// (pkg/molten/mission/annotate.go, answered to windows only).

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

// capturePage: the picture of what the window shows in a rectangle given in the page's own pixels; "" when the
// window cannot take one. The frame of the main process is in display units, which the window's zoom scales.
export async function capturePage(rect: { left: number; top: number; width: number; height: number }): Promise<string> {
    const api = getApi();
    if (api?.captureScreenshot == null || !(rect.width > 0) || !(rect.height > 0)) {
        return "";
    }
    const zoom = api.getZoomFactor?.() || 1;
    const url = await api.captureScreenshot({
        x: Math.round(rect.left * zoom),
        y: Math.round(rect.top * zoom),
        width: Math.max(1, Math.round(rect.width * zoom)),
        height: Math.max(1, Math.round(rect.height * zoom)),
    });
    return typeof url === "string" && url.startsWith("data:image/") && url.length > MinCaptureChars ? url : "";
}
