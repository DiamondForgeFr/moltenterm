// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The DevTools operations an agent session may run on a browser panel tab (DS-BRW-012). emain is the last gate: wavesrv
// decides which tool runs which method, and emain executes only these, on registered panel webviews under agent
// control. Anything else is refused, raw passthrough included: no cookies, storage, IndexedDB, cache, targets, browser
// or request interception, ever.
//
// Runtime.evaluate / Runtime.callFunctionOn and DOM.setFileInputFiles are not listed yet: they come with the stories
// that add their guards (isolated world and JavaScript opt-in, FR-BRW-009/012; confirmation of file inputs, FR-BRW-010).

export const CdpProtocolVersion = "1.3";

export const CdpAllowedMethods: ReadonlySet<string> = new Set([
    "Page.navigate",
    "Page.getNavigationHistory",
    "Page.navigateToHistoryEntry",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Page.createIsolatedWorld",
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Accessibility.queryAXTree",
    "DOM.getDocument",
    "DOM.describeNode",
    "DOM.resolveNode",
    "DOM.getBoxModel",
    "DOM.scrollIntoViewIfNeeded",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.clearDeviceMetricsOverride",
    "Runtime.enable",
    "Log.enable",
    "Network.enable",
]);

export function cdpMethodAllowed(method: unknown): boolean {
    return typeof method === "string" && CdpAllowedMethods.has(method);
}

// The agent's own input (Input.* through the debugger) must not read as the user's.
export function isSyntheticInputMethod(method: string): boolean {
    return method.startsWith("Input.");
}

// Any click or key from the user in a controlled page takes over (FR-BRW-008 AC7).
export function isTakeoverKey(input: { type: string }): boolean {
    return input?.type === "keyDown" || input?.type === "rawKeyDown";
}

export function isTakeoverMouse(mouse: { type: string }): boolean {
    return mouse?.type === "mouseDown";
}

const MaxIdLength = 200;

function validId(id: unknown): id is string {
    return typeof id === "string" && id !== "" && id.length <= MaxIdLength;
}

export function validRegistration(blockId: unknown, browserTabId: unknown, webContentsId: unknown): boolean {
    return (
        validId(blockId) && validId(browserTabId) && Number.isInteger(webContentsId) && (webContentsId as number) > 0
    );
}

export function webviewKey(blockId: string, browserTabId: string): string {
    return `${blockId}/${browserTabId}`;
}
