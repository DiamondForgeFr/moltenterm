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
    "Accessibility.disable",
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

// MoltenTerm's own operations (FR-BRW-009): emain runs them with fixed code, so wavesrv names an operation and its
// bounded parameters, never a script. Must match the op* constants in pkg/molten/browseragent/pages.go.
export const OpNavigate = "Molten.navigate";
export const OpPageText = "Molten.pageText";
export const OpCapture = "Molten.capture";
export const MoltenOperations: ReadonlySet<string> = new Set([OpNavigate, OpPageText, OpCapture]);

export function isMoltenOperation(method: unknown): boolean {
    return typeof method === "string" && MoltenOperations.has(method);
}

// history moves to the entry wavesrv checked: index, which must still hold the URL expect.
export type NavigateParams = { url?: string; history?: { index: number; expect: string }; timeoutMs: number };
export type PageTextParams = { maxChars: number };
export type CaptureParams = {
    clip?: { x: number; y: number; width: number; height: number };
    maxSide: number;
    scale: number;
    format: "jpeg" | "png";
    quality: number;
    maxBytes: number;
};

const MaxNavigateTimeoutMs = 30000;
const MaxUrlLength = 8192;
const MaxPageTextChars = 2_000_000;
const MaxClipSide = 20000;

function finiteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

// Only http(s) pages, without credentials in the URL (DS-BRW-015); wavesrv checks the same, emain is the last gate.
export function webPageUrl(url: unknown): string {
    if (typeof url !== "string" || url.length > MaxUrlLength) {
        return null;
    }
    try {
        const u = new URL(url);
        if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "") {
            return null;
        }
        return u.toString();
    } catch {
        return null;
    }
}

export function navigateParams(params: any): NavigateParams {
    const timeoutMs = finiteNumber(params?.timeoutms)
        ? clamp(params.timeoutms, 1000, MaxNavigateTimeoutMs)
        : MaxNavigateTimeoutMs;
    if (params?.history != null) {
        const index = params.history.index;
        const expect = params.history.expect;
        if (params.url != null || !Number.isInteger(index) || index < 0 || typeof expect !== "string") {
            return null;
        }
        if (expect !== "about:blank" && webPageUrl(expect) == null) {
            return null;
        }
        return { history: { index, expect }, timeoutMs };
    }
    const url = webPageUrl(params?.url);
    return url == null ? null : { url, timeoutMs };
}

// The properties read_page and find use (pkg/molten/browseragent/axtree.go); the rest of a node stays in emain.
const AxProperties = new Set([
    "editable",
    "checked",
    "selected",
    "expanded",
    "pressed",
    "disabled",
    "required",
    "level",
    "url",
]);

function axValue(v: any): any {
    if (v == null || v.value == null) {
        return undefined;
    }
    const value = typeof v.value === "string" ? v.value.slice(0, 2000) : v.value;
    return typeof value === "object" ? undefined : { value };
}

// A large page's tree is tens of megabytes as DevTools sends it (name sources, ignored reasons, every property): only
// what the reading tools use crosses to wavesrv.
export function slimAxTree(tree: any): any {
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    return {
        nodes: nodes.map((n: any) => {
            const slim: any = { nodeId: n?.nodeId, ignored: n?.ignored === true };
            for (const field of ["role", "name", "value", "description"]) {
                const v = axValue(n?.[field]);
                if (v !== undefined) {
                    slim[field] = v;
                }
            }
            const props = (Array.isArray(n?.properties) ? n.properties : [])
                .filter((p: any) => AxProperties.has(p?.name))
                .map((p: any) => ({ name: p.name, value: axValue(p.value) ?? {} }));
            if (props.length > 0) {
                slim.properties = props;
            }
            if (Array.isArray(n?.childIds) && n.childIds.length > 0) {
                slim.childIds = n.childIds;
            }
            if (n?.parentId != null) {
                slim.parentId = n.parentId;
            }
            if (Number.isInteger(n?.backendDOMNodeId)) {
                slim.backendDOMNodeId = n.backendDOMNodeId;
            }
            return slim;
        }),
    };
}

// A main-frame redirect to another host stops, so wavesrv can ask for its site before it loads (NFR-BRW-005).
export function redirectLeavesHost(from: string, to: string): boolean {
    try {
        return new URL(from).host.toLowerCase() !== new URL(to).host.toLowerCase();
    } catch {
        return true;
    }
}

export function pageTextParams(params: any): PageTextParams {
    if (!finiteNumber(params?.maxchars) || params.maxchars < 1) {
        return null;
    }
    return { maxChars: Math.floor(Math.min(params.maxchars, MaxPageTextChars)) };
}

export function captureParams(params: any): CaptureParams {
    if (params?.format !== "jpeg" && params?.format !== "png") {
        return null;
    }
    const rtn: CaptureParams = {
        maxSide: finiteNumber(params.maxside) ? Math.round(clamp(params.maxside, 64, 4096)) : 1568,
        scale: finiteNumber(params.scale) ? clamp(params.scale, 0.1, 1) : 1,
        format: params.format,
        quality: finiteNumber(params.quality) ? Math.round(clamp(params.quality, 10, 100)) : 80,
        maxBytes: finiteNumber(params.maxbytes) ? Math.round(clamp(params.maxbytes, 50_000, 4 << 20)) : 1 << 20,
    };
    if (params.clip != null) {
        const { x, y, width, height } = params.clip;
        if (![x, y, width, height].every(finiteNumber) || x < 0 || y < 0 || width < 1 || height < 1) {
            return null;
        }
        if (x + width > MaxClipSide || y + height > MaxClipSide) {
            return null;
        }
        rtn.clip = { x, y, width, height };
    }
    return rtn;
}

// The image size for a capture: at most maxSide on the long side, times scale, never larger than the capture itself.
export function captureTargetSize(
    width: number,
    height: number,
    maxSide: number,
    scale: number
): { width: number; height: number } {
    const long = Math.max(width, height);
    if (long <= 0) {
        return { width: 0, height: 0 };
    }
    const factor = (Math.min(long, maxSide) / long) * scale;
    return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

// Composites a premultiplied BGRA bitmap over white, in place: each channel gains what the pixel's alpha leaves.
export function flattenBitmapOnWhite(bitmap: Uint8Array): void {
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const rest = 255 - bitmap[i + 3];
        if (rest === 0) {
            continue;
        }
        bitmap[i] = Math.min(255, bitmap[i] + rest);
        bitmap[i + 1] = Math.min(255, bitmap[i + 1] + rest);
        bitmap[i + 2] = Math.min(255, bitmap[i + 2] + rest);
        bitmap[i + 3] = 255;
    }
}

// The fixed script get_page_text runs in an isolated world (DS-BRW-014): the page's own scripts cannot change what it
// reads, and form field values are not part of innerText. maxChars is a validated integer.
export function pageTextScript(maxChars: number): string {
    const max = Math.floor(maxChars);
    return `(() => {
    const text = (el) => (el && typeof el.innerText === "string" ? el.innerText : "");
    let source = "body";
    let root = document.body;
    const main = document.querySelector("main, [role=main]");
    const articles = document.querySelectorAll("article");
    if (main && text(main).trim() !== "") {
        source = "main";
        root = main;
    } else if (articles.length === 1 && text(articles[0]).trim() !== "") {
        source = "article";
        root = articles[0];
    }
    const all = text(root);
    const chars = Array.from(all);
    return { text: chars.slice(0, ${max}).join(""), length: chars.length, source, title: String(document.title || "") };
})()`;
}

// A world of its own for MoltenTerm's reading script: 0 is the page's, 999 Electron's preload world.
export const ReaderWorldId = 1301;

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
