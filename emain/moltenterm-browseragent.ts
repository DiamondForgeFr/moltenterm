// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// emain's side of the agents in the browser panel (FR-BRW-008, DS-BRW-010/011/012). It keeps a registry of the panel
// tabs' webviews, fed by the panels themselves (the existing lookup by block id only finds a panel's first webview),
// runs the allow-listed DevTools methods wavesrv sends through webContents.debugger, and watches a controlled tab for
// the user's own clicks and keys, which take over from the agent. For FR-BRW-010 it also tells the agent's own input
// from the user's by sequence, holds back the downloads of controlled tabs until the user answers, and clears the
// emulated viewport when control ends.

import { ipcMain, nativeImage, webContents, type WebContents } from "electron";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthKey } from "./authkey";
import {
    captureParams,
    captureTargetSize,
    cdpMethodAllowed,
    CdpProtocolVersion,
    downloadHost,
    expectedSignature,
    flattenBitmapOnWhite,
    InspectElementSource,
    InspectFocusedScript,
    inspectParams,
    inspectPointScript,
    isMoltenOperation,
    isSyntheticInputMethod,
    isTakeoverKey,
    isTakeoverMouse,
    nativeKeySignature,
    nativeMouseSignature,
    navigateParams,
    OpCapture,
    OpInspect,
    OpNavigate,
    OpPageText,
    OpSetField,
    pageSignature,
    pageTextParams,
    pageTextScript,
    ReaderWorldId,
    redirectLeavesHost,
    sanitizeEmulationParams,
    sanitizeInputParams,
    setFieldParams,
    SetFieldSource,
    slimAxTree,
    SyntheticInputLedger,
    validRegistration,
    webviewKey,
} from "./moltenterm-browseragent-policy";

// Sent by frontend/moltenterm-shell/browser/browser-view.tsx when a tab's webview is ready.
export const WebviewRegisteredChannel = "moltenterm-webview-registered";
// Sent by a panel page's preload (emain/preload-webview.ts) on the user's trusted mousedown or keydown.
export const WebviewInputChannel = "moltenterm-webview-input";

// must match emainTokenLabel in pkg/molten/browseragent/waveenv.go: wavesrv proves it sent a command with a token
// derived from the auth key emain gave it, since any route can address emain.
const EmainTokenLabel = "molten:browseragent";
const ExpectedToken = createHmac("sha256", AuthKey).update(EmainTokenLabel).digest();

const RegistrationWaitMs = 5000;
const RegistrationPollMs = 50;

export type CdpCallData = { blockid: string; browsertabid: string; method: string; params?: any; token: string };
export type ControlData = { blockid: string; browsertabid: string; controlled: boolean; token: string };
export type TakeoverReport = (blockId: string, browserTabId: string) => void;
// Asks wavesrv whether a download a controlled tab started may go on; resolves to the user's answer.
export type DownloadAsk = (blockId: string, browserTabId: string, host: string) => Promise<boolean>;

type Registration = { blockId: string; browserTabId: string; webContentsId: number };

const registry = new Map<string, Registration>();
const controlled = new Set<string>();
// Tabs the user took over: refused here at once, before wavesrv hears of it, until control is granted again.
const paused = new Set<string>();
const watchers = new Map<number, () => void>();
const synthetic = new SyntheticInputLedger();
// The classification of one native input event, shared by every listener that sees the same event object.
const nativeVerdicts = new WeakMap<object, boolean>();
// webContents whose viewport the agent emulates (resize), with the size, cleared when control ends.
const emulated = new Map<number, { width: number; height: number }>();
// A download the user allowed, started again by emain: it goes through once.
const allowedDownloads = new Map<number, { url: string; until: number }>();
const hookedSessions = new WeakSet<Electron.Session>();
const DownloadAllowanceMs = 30000;
let reportTakeover: TakeoverReport = () => {};
let askDownload: DownloadAsk = async () => false;

function fromWavesrv(token: unknown): boolean {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return false;
    }
    return timingSafeEqual(Buffer.from(token, "hex"), ExpectedToken);
}

function liveContents(id: number): WebContents {
    const wc = webContents.fromId(id);
    return wc == null || wc.isDestroyed() ? null : wc;
}

function noteUserInput(reg: Registration): void {
    const key = webviewKey(reg.blockId, reg.browserTabId);
    if (paused.has(key)) {
        return;
    }
    paused.add(key);
    reportTakeover(reg.blockId, reg.browserTabId);
}

function startWatching(reg: Registration, wc: WebContents): void {
    if (watchers.has(wc.id)) {
        return;
    }
    const onKey = (_e: Electron.Event, input: Electron.Input) => {
        if (isTakeoverKey(input) && !isAgentInput(wc.id, input)) {
            noteUserInput(reg);
        }
    };
    const onMouse = (_e: Electron.Event, mouse: Electron.MouseInputEvent) => {
        if (!isTakeoverMouse(mouse)) {
            return;
        }
        if (!synthetic.claim(wc.id, "native", nativeMouseSignature(mouse), Date.now(), wc.getZoomFactor())) {
            noteUserInput(reg);
        }
    };
    wc.on("before-input-event", onKey);
    wc.on("before-mouse-event", onMouse);
    // A page under control keeps running while its Wave tab or panel tab is hidden.
    wc.setBackgroundThrottling(false);
    hookDownloads(wc);
    watchers.set(wc.id, () => {
        wc.off("before-input-event", onKey);
        wc.off("before-mouse-event", onMouse);
        wc.setBackgroundThrottling(true);
    });
}

// isAgentInput tells whether a native key event of a webview is the agent's own (FR-BRW-010 AC6): Wave's webview key
// handling (emain/emain-ipc.ts) skips it, so a cmd+w the agent sends to the page never closes anything of MoltenTerm.
// Every listener of the same event gets the same answer.
export function isAgentInput(wcId: number, input: Electron.Input): boolean {
    if (input == null || typeof input !== "object") {
        return false;
    }
    const known = nativeVerdicts.get(input);
    if (known != null) {
        return known;
    }
    const verdict = isTakeoverKey(input) && synthetic.claim(wcId, "native", nativeKeySignature(input), Date.now());
    nativeVerdicts.set(input, verdict);
    return verdict;
}

function stopWatching(wc: WebContents): void {
    const stop = watchers.get(wc.id);
    watchers.delete(wc.id);
    stop?.();
    synthetic.forget(wc.id);
    allowedDownloads.delete(wc.id);
    if (!wc.debugger.isAttached()) {
        emulated.delete(wc.id);
        return;
    }
    const detach = () => {
        try {
            if (wc.debugger.isAttached()) {
                wc.debugger.detach();
            }
        } catch (e) {
            console.log("molten browser agent: detach failed", e);
        }
    };
    if (!emulated.delete(wc.id)) {
        detach();
        return;
    }
    // The page returns to the panel's size when control ends (FR-BRW-010 AC3).
    wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {}).then(detach, detach);
}

// Downloads of a tab under an agent's control wait for the user (DS-BRW-016): emain cancels them and asks wavesrv,
// which shows Allow / Deny on the tab; on Allow emain starts the same URL again, and it goes through once.
function hookDownloads(wc: WebContents): void {
    const ses = wc.session;
    if (ses == null || hookedSessions.has(ses)) {
        return;
    }
    hookedSessions.add(ses);
    ses.on("will-download", (event, item, source) => {
        const reg = source == null ? null : registrationOf(source.id);
        if (reg == null) {
            return;
        }
        const key = webviewKey(reg.blockId, reg.browserTabId);
        if (!controlled.has(key) || paused.has(key)) {
            return;
        }
        const url = item.getURL();
        const allowance = allowedDownloads.get(source.id);
        if (allowance != null && allowance.url === url && Date.now() < allowance.until) {
            allowedDownloads.delete(source.id);
            return;
        }
        event.preventDefault();
        askDownload(reg.blockId, reg.browserTabId, downloadHost(url)).then(
            (allow) => {
                if (!allow || source.isDestroyed()) {
                    return;
                }
                allowedDownloads.set(source.id, { url, until: Date.now() + DownloadAllowanceMs });
                source.downloadURL(url);
            },
            (e) => console.log("molten browser agent: download question failed", e)
        );
    });
}

function registrationOf(wcId: number): Registration {
    for (const reg of registry.values()) {
        if (reg.webContentsId === wcId) {
            return reg;
        }
    }
    return null;
}

function applyControl(key: string): void {
    const reg = registry.get(key);
    const wc = reg ? liveContents(reg.webContentsId) : null;
    if (wc == null) {
        return;
    }
    if (controlled.has(key)) {
        startWatching(reg, wc);
        return;
    }
    stopWatching(wc);
}

function register(event: Electron.IpcMainEvent, blockId: unknown, browserTabId: unknown, webContentsId: unknown): void {
    if (!validRegistration(blockId, browserTabId, webContentsId)) {
        return;
    }
    const wc = liveContents(webContentsId as number);
    // Only a webview guest of the window that reports it: a page cannot register itself or another window's tab.
    if (wc == null || wc.getType() !== "webview" || wc.hostWebContents?.id !== event.sender.id) {
        return;
    }
    const key = webviewKey(blockId as string, browserTabId as string);
    const previous = registry.get(key);
    // dom-ready comes again with each page load of the same webview.
    if (previous?.webContentsId === wc.id) {
        applyControl(key);
        return;
    }
    if (previous != null) {
        const old = liveContents(previous.webContentsId);
        if (old != null) {
            stopWatching(old);
        }
    }
    const reg: Registration = {
        blockId: blockId as string,
        browserTabId: browserTabId as string,
        webContentsId: wc.id,
    };
    registry.set(key, reg);
    wc.once("destroyed", () => {
        watchers.delete(reg.webContentsId);
        synthetic.forget(reg.webContentsId);
        emulated.delete(reg.webContentsId);
        allowedDownloads.delete(reg.webContentsId);
        if (registry.get(key)?.webContentsId === reg.webContentsId) {
            registry.delete(key);
        }
    });
    applyControl(key);
}

// moltenbrowsercontrol: wavesrv marks a tab as driven by an agent, or releases it (Stop, the agent left).
export function setBrowserAgentControl(data: ControlData): void {
    if (!fromWavesrv(data?.token) || !validRegistration(data?.blockid, data?.browsertabid, 1)) {
        return;
    }
    const key = webviewKey(data.blockid, data.browsertabid);
    paused.delete(key);
    if (data.controlled) {
        controlled.add(key);
    } else {
        controlled.delete(key);
    }
    applyControl(key);
}

// A tab the agent just opened registers its webview once the panel has mounted it: the first call waits for it a
// moment instead of failing.
async function registeredContents(key: string): Promise<WebContents> {
    const deadline = Date.now() + RegistrationWaitMs;
    for (;;) {
        const reg = registry.get(key);
        const wc = reg ? liveContents(reg.webContentsId) : null;
        if (wc != null || Date.now() >= deadline || !controlled.has(key)) {
            return wc;
        }
        await new Promise((resolve) => setTimeout(resolve, RegistrationPollMs));
    }
}

// moltenbrowsercdp: one allow-listed DevTools method on a controlled, registered tab. The debugger attaches on first
// use and detaches when control ends.
export async function runBrowserAgentCdp(data: CdpCallData): Promise<any> {
    if (!fromWavesrv(data?.token)) {
        throw new Error("only MoltenTerm's agent sessions can drive a browser tab");
    }
    const operation = isMoltenOperation(data?.method);
    if (!operation && !cdpMethodAllowed(data?.method)) {
        throw new Error(`DevTools method not allowed: ${String(data?.method).slice(0, 80)}`);
    }
    if (!validRegistration(data.blockid, data.browsertabid, 1)) {
        throw new Error("no such tab");
    }
    const key = webviewKey(data.blockid, data.browsertabid);
    if (!controlled.has(key)) {
        throw new Error("This tab is not under agent control");
    }
    if (paused.has(key)) {
        throw new Error("The user has taken over");
    }
    const wc = await registeredContents(key);
    if (wc == null) {
        throw new Error("The tab's page is not loaded: show its MoltenTerm tab");
    }
    // The wait may have outlived the agent's control of the tab.
    if (!controlled.has(key)) {
        throw new Error("This tab is not under agent control");
    }
    if (paused.has(key)) {
        throw new Error("The user has taken over");
    }
    if (operation) {
        return runOperation(wc, data.method, data.params);
    }
    attachDebugger(wc);
    let params = data.params ?? {};
    if (isSyntheticInputMethod(data.method)) {
        params = sanitizeInputParams(data.method, params);
        if (params == null) {
            throw new Error("bad input parameters");
        }
        const signature = expectedSignature(data.method, params);
        if (signature != null) {
            synthetic.expect(wc.id, signature, Date.now());
        }
    } else if (data.method === "Emulation.setDeviceMetricsOverride") {
        params = sanitizeEmulationParams(params);
        if (params == null) {
            throw new Error("bad viewport size");
        }
        emulated.set(wc.id, { width: params.width, height: params.height });
    }
    const result = await wc.debugger.sendCommand(data.method, params);
    return data.method === "Accessibility.getFullAXTree" ? slimAxTree(result) : result;
}

function attachDebugger(wc: WebContents): void {
    if (wc.isDevToolsOpened()) {
        throw new Error("Close DevTools on this tab to let the agent use it");
    }
    if (!wc.debugger.isAttached()) {
        wc.debugger.attach(CdpProtocolVersion);
    }
}

// MoltenTerm's own isolated world in the page's main frame, for the fixed functions below; a new document gets a new
// one.
const readerContexts = new Map<number, { loaderId: string; contextId: number }>();

async function readerContext(wc: WebContents): Promise<number> {
    const tree = await wc.debugger.sendCommand("Page.getFrameTree", {});
    const frame = tree?.frameTree?.frame;
    if (typeof frame?.id !== "string") {
        throw new Error("no main frame");
    }
    const cached = readerContexts.get(wc.id);
    if (cached != null && cached.loaderId === frame.loaderId) {
        return cached.contextId;
    }
    const world = await wc.debugger.sendCommand("Page.createIsolatedWorld", {
        frameId: frame.id,
        worldName: "moltenterm-agent",
        grantUniveralAccess: false,
    });
    if (!Number.isInteger(world?.executionContextId)) {
        throw new Error("no isolated world");
    }
    readerContexts.set(wc.id, { loaderId: frame.loaderId, contextId: world.executionContextId });
    if (readerContexts.size > 200) {
        readerContexts.delete(readerContexts.keys().next().value);
    }
    return world.executionContextId;
}

// callOnNode runs a fixed function on a DOM node in MoltenTerm's isolated world: the node's wrapper there is not the
// page's, so page scripts cannot fake its properties.
async function callOnNode(
    wc: WebContents,
    backendNodeId: number,
    functionDeclaration: string,
    args: any[]
): Promise<any> {
    attachDebugger(wc);
    let contextId = await readerContext(wc);
    let resolved: any;
    try {
        resolved = await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId, executionContextId: contextId });
    } catch {
        // The world went with its document: make a new one, once.
        readerContexts.delete(wc.id);
        contextId = await readerContext(wc);
        resolved = await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId, executionContextId: contextId });
    }
    const objectId = resolved?.object?.objectId;
    if (typeof objectId !== "string") {
        throw new Error("node not found");
    }
    try {
        const out = await wc.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: false,
        });
        if (out?.exceptionDetails != null) {
            throw new Error("the function failed");
        }
        return out?.result?.value;
    } finally {
        wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
}

// Molten.inspect: what the element at a point, of a node, or with the focus is (DS-BRW-016), from fixed code.
async function inspectOp(wc: WebContents, raw: any): Promise<any> {
    const params = inspectParams(raw);
    if (params == null) {
        throw new Error("bad inspect parameters");
    }
    if (params.backendNodeId != null) {
        return callOnNode(wc, params.backendNodeId, `function () { return (${InspectElementSource})(this); }`, []);
    }
    const code = params.focused ? InspectFocusedScript : inspectPointScript(params.point.x, params.point.y);
    return wc.executeJavaScriptInIsolatedWorld(ReaderWorldId, [{ code }]);
}

// Molten.setField: form_input's fixed function on the field's node.
async function setFieldOp(wc: WebContents, raw: any): Promise<any> {
    const params = setFieldParams(raw);
    if (params == null) {
        throw new Error("bad field parameters");
    }
    try {
        return await callOnNode(wc, params.backendNodeId, SetFieldSource, [params.value]);
    } catch {
        return { ok: false, error: "gone" };
    }
}

type NavigateOutcome = { url: string; title: string; status: number; error: string; redirect?: string };

// Molten.navigate: loads a URL or moves in the history, and answers once the load ends (or at the timeout) with the
// final URL, the main frame's HTTP status and the load error, if any.
function navigateOp(wc: WebContents, raw: any): Promise<NavigateOutcome> {
    const params = navigateParams(raw);
    if (params == null) {
        return Promise.reject(new Error("Only http and https pages can be opened"));
    }
    return new Promise((resolve) => {
        let status = 0;
        let error = "";
        let started = false;
        let finished = false;
        let redirect = "";
        // A history move is stopped too when the entry's server now redirects elsewhere.
        let current = params.url ?? params.history?.expect;
        const onNavigate = (_e: Electron.Event, _url: string, code: number) => {
            status = code;
        };
        const onStart = () => {
            started = true;
        };
        const onFail = (_e: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean) => {
            // -3 is ERR_ABORTED: another navigation (a redirect by script, a download) replaced this one.
            if (isMainFrame && code !== -3) {
                error = description || `ERR_${-code}`;
            }
        };
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            wc.off("did-navigate", onNavigate);
            wc.off("did-start-loading", onStart);
            wc.off("did-fail-load", onFail);
            wc.off("did-stop-loading", onStop);
            wc.off("did-navigate-in-page", onInPage);
            wc.off("will-redirect", onRedirect);
            if (wc.isDestroyed()) {
                resolve({ url: "", title: "", status, error: error || "ERR_TAB_CLOSED" });
                return;
            }
            if (redirect !== "") {
                resolve({ url: wc.getURL(), title: "", status: 0, error: "", redirect });
                return;
            }
            resolve({ url: wc.getURL(), title: wc.getTitle(), status, error });
        };
        const onStop = () => {
            if (started) {
                finish();
            }
        };
        const onInPage = (_e: Electron.Event, _url: string, isMainFrame: boolean) => {
            if (isMainFrame && !wc.isLoading()) {
                finish();
            }
        };
        const onRedirect = (details: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
            if (!details.isMainFrame || current == null) {
                return;
            }
            if (!redirectLeavesHost(current, details.url)) {
                current = details.url;
                return;
            }
            details.preventDefault();
            redirect = details.url.slice(0, 8192);
            finish();
        };
        const timer = setTimeout(finish, params.timeoutMs);
        wc.on("will-redirect", onRedirect);
        wc.on("did-navigate", onNavigate);
        wc.on("did-start-loading", onStart);
        wc.on("did-fail-load", onFail);
        wc.on("did-stop-loading", onStop);
        wc.on("did-navigate-in-page", onInPage);
        if (params.url != null) {
            wc.loadURL(params.url).then(finish, finish);
            return;
        }
        const history = wc.navigationHistory;
        const { index, expect } = params.history;
        // The tab may have moved since wavesrv checked the entry: go only to the entry it allowed.
        if (index >= history.length() || history.getEntryAtIndex(index)?.url !== expect) {
            error = "ERR_HISTORY_CHANGED";
            finish();
            return;
        }
        history.goToIndex(index);
    });
}

// Molten.pageText: the fixed reading script, in a world of MoltenTerm's own.
async function pageTextOp(wc: WebContents, raw: any): Promise<any> {
    const params = pageTextParams(raw);
    if (params == null) {
        throw new Error("bad page text parameters");
    }
    const result = await wc.executeJavaScriptInIsolatedWorld(ReaderWorldId, [
        { code: pageTextScript(params.maxChars) },
    ]);
    return {
        text: typeof result?.text === "string" ? result.text.slice(0, params.maxChars) : "",
        length: Number.isFinite(result?.length) ? result.length : 0,
        source: typeof result?.source === "string" ? result.source : "body",
        title: typeof result?.title === "string" ? result.title.slice(0, 1000) : "",
    };
}

// The panel's pages are drawn on a transparent background; a page without a background of its own would come out
// black in a JPEG. The agent sees what a browser draws: the page over white.
function flattenOnWhite(image: Electron.NativeImage): Electron.NativeImage {
    const size = image.getSize();
    const bitmap = image.toBitmap();
    if (bitmap.length !== size.width * size.height * 4) {
        return image;
    }
    flattenBitmapOnWhite(bitmap);
    return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
}

function encodeImage(image: Electron.NativeImage, format: "jpeg" | "png", quality: number): Buffer {
    return format === "png" ? image.toPNG() : image.toJPEG(quality);
}

// Molten.capture: the viewport or a region of it, in CSS pixels. capturePage paints a page whose MoltenTerm tab is
// hidden (stayHidden keeps it hidden from the page's point of view); the image is scaled down and encoded until it
// fits maxBytes.
async function captureOp(wc: WebContents, raw: any): Promise<any> {
    const params = captureParams(raw);
    if (params == null) {
        throw new Error("bad capture parameters");
    }
    const zoom = wc.getZoomFactor() || 1;
    const rect = params.clip
        ? {
              x: Math.round(params.clip.x * zoom),
              y: Math.round(params.clip.y * zoom),
              width: Math.max(1, Math.round(params.clip.width * zoom)),
              height: Math.max(1, Math.round(params.clip.height * zoom)),
          }
        : undefined;
    let image = await wc.capturePage(rect, { stayHidden: true });
    if (image.isEmpty()) {
        throw new Error("The page could not be captured: show its MoltenTerm tab once");
    }
    // An emulated viewport is drawn from the panel's top-left corner, unscaled: the screenshot is that area, as far as
    // the panel shows it, and says which CSS size it covers.
    const emulatedSize = params.clip ? null : emulated.get(wc.id);
    let cssSize: { csswidth: number; cssheight: number } = null;
    if (emulatedSize != null) {
        const full = image.getSize();
        const crop = {
            x: 0,
            y: 0,
            width: Math.max(1, Math.min(full.width, Math.round(emulatedSize.width * zoom))),
            height: Math.max(1, Math.min(full.height, Math.round(emulatedSize.height * zoom))),
        };
        image = image.crop(crop);
        cssSize = { csswidth: crop.width / zoom, cssheight: crop.height / zoom };
    }
    const dip = image.getSize();
    const pixelScale = Math.max(1, ...(image.getScaleFactors?.() ?? [1]));
    let size = captureTargetSize(dip.width * pixelScale, dip.height * pixelScale, params.maxSide, params.scale);
    let format = params.format;
    let quality = params.quality;
    let resized: Electron.NativeImage = null;
    let resizedFor = "";
    for (let attempt = 0; attempt < 8; attempt++) {
        const sizeKey = `${size.width}x${size.height}`;
        if (resizedFor !== sizeKey) {
            resized = flattenOnWhite(image.resize({ width: size.width, height: size.height, quality: "good" }));
            resizedFor = sizeKey;
        }
        const data = encodeImage(resized, format, quality);
        if (data.length <= params.maxBytes || size.width <= 64) {
            const out = resized.getSize();
            return {
                data: data.toString("base64"),
                mimetype: format === "png" ? "image/png" : "image/jpeg",
                width: out.width,
                height: out.height,
                ...cssSize,
            };
        }
        if (format === "png") {
            format = "jpeg";
            quality = 90;
        } else if (quality > 50) {
            quality = Math.max(50, quality - 20);
        } else {
            size = { width: Math.round(size.width * 0.75), height: Math.round(size.height * 0.75) };
        }
    }
    throw new Error("The capture is too large");
}

function runOperation(wc: WebContents, method: string, params: any): Promise<any> {
    switch (method) {
        case OpNavigate:
            return navigateOp(wc, params);
        case OpPageText:
            return pageTextOp(wc, params);
        case OpCapture:
            return captureOp(wc, params);
        case OpInspect:
            return inspectOp(wc, params);
        case OpSetField:
            return setFieldOp(wc, params);
    }
    return Promise.reject(new Error("unknown operation"));
}

// A Wave tab view showing a tab under agent control stays in emain's cache (DS-BRW-010): evicting it would destroy the
// page the agent drives and reads.
export function hostsControlledTab(hostWebContentsId: number): boolean {
    for (const key of controlled) {
        const reg = registry.get(key);
        const wc = reg ? liveContents(reg.webContentsId) : null;
        if (wc?.hostWebContents?.id === hostWebContentsId) {
            return true;
        }
    }
    return false;
}

// The preload sees input in the page's main frame, the agent's included, and reports what it was; before-input-event
// and before-mouse-event also catch native input the page's frames get. The agent's own input is claimed by sequence.
function pageInput(event: Electron.IpcMainEvent, report: unknown): void {
    for (const [key, reg] of registry) {
        if (reg.webContentsId !== event.sender.id || !controlled.has(key)) {
            continue;
        }
        const signature = pageSignature(report);
        if (signature == null || !synthetic.claim(event.sender.id, "page", signature, Date.now())) {
            noteUserInput(reg);
        }
        return;
    }
}

export function initMoltentermBrowserAgent(report: TakeoverReport, ask: DownloadAsk): void {
    reportTakeover = report;
    askDownload = ask;
    ipcMain.on(WebviewRegisteredChannel, register);
    ipcMain.on(WebviewInputChannel, pageInput);
}
