// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The DevTools operations an agent session may run on a browser panel tab (DS-BRW-012). emain is the last gate: wavesrv
// decides which tool runs which method, and emain executes only these, on registered panel webviews under agent
// control. Anything else is refused, raw passthrough included: no cookies, storage, IndexedDB, cache, targets, browser
// or request interception, ever.
//
// Runtime.evaluate / Runtime.callFunctionOn are not listed: emain runs them itself, for its fixed functions in
// MoltenTerm's isolated world only (Molten.inspect, Molten.setField). JavaScript in the page's world comes with its
// opt-in (FR-BRW-012). DOM.setFileInputFiles is not listed either: no tool supplies files, and a file input opens the
// user's own file chooser after the user's Allow (FR-BRW-010).

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
export const OpInspect = "Molten.inspect";
export const OpSetField = "Molten.setField";
export const MoltenOperations: ReadonlySet<string> = new Set([
    OpNavigate,
    OpPageText,
    OpCapture,
    OpInspect,
    OpSetField,
]);

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

const MouseEventTypes = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
// No middle button: on Linux it pastes the selection, outside the page.
const MouseButtons = new Set(["none", "left", "right"]);
const KeyEventTypes = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
// Selection and undo only: copy, cut and paste would reach the user's clipboard, outside the page (FR-BRW-010 AC6).
export const AllowedEditingCommands: ReadonlySet<string> = new Set(["selectAll", "undo", "redo"]);
const MaxInsertText = 10000;
const MaxKeyField = 32;
const MaxCoordinate = 100000;
const MaxWheelDelta = 10000;

function wholeIn(v: unknown, lo: number, hi: number): v is number {
    return Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
}

function shortString(v: unknown, max: number): v is string {
    return typeof v === "string" && v.length <= max;
}

const ModCtrl = 2;
const ModMeta = 4;
const ModShift = 8;

// Copy, cut and paste shortcuts on every system (FR-BRW-010 AC6): on Windows and Linux the page's engine runs them from
// the key itself, without any editing command, so dropping the commands is not enough.
export function isClipboardChord(key: string, code: string, modifiers: number): boolean {
    const k = String(key ?? "").toLowerCase();
    const c = String(code ?? "");
    if (
        (modifiers & (ModCtrl | ModMeta)) !== 0 &&
        (["c", "x", "v"].includes(k) || ["KeyC", "KeyX", "KeyV"].includes(c))
    ) {
        return true;
    }
    if (k === "insert" || c === "Insert") {
        return (modifiers & (ModCtrl | ModShift)) !== 0;
    }
    if (k === "delete" || c === "Delete") {
        return (modifiers & ModShift) !== 0;
    }
    return k === "paste" || k === "copy" || k === "cut";
}

// The host of the page an input action was planned on must still be the tab's (FR-BRW-008 AC7): a key or a chunk of
// text that reaches a page of another site has skipped that site's permission.
export function inputHostMatches(pageUrl: string, expected: unknown): boolean {
    if (typeof expected !== "string" || expected === "") {
        return false;
    }
    try {
        const u = new URL(pageUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
            return false;
        }
        return u.host.toLowerCase() === expected;
    } catch {
        return false;
    }
}

export const SiteChangedError = "molten:site-changed";

// The Input.* events emain sends for wavesrv, rebuilt from known fields with bounded values; anything else is refused.
export function sanitizeInputParams(method: string, params: any): any {
    if (method === "Input.insertText") {
        return shortString(params?.text, MaxInsertText) ? { text: params.text } : null;
    }
    const modifiers = params?.modifiers ?? 0;
    if (!wholeIn(modifiers, 0, 15)) {
        return null;
    }
    if (method === "Input.dispatchMouseEvent") {
        const { type, x, y } = params ?? {};
        if (!MouseEventTypes.has(type) || !finiteNumber(x) || !finiteNumber(y)) {
            return null;
        }
        if (Math.abs(x) > MaxCoordinate || Math.abs(y) > MaxCoordinate) {
            return null;
        }
        const out: any = { type, x, y, modifiers };
        const button = params.button ?? "none";
        const buttons = params.buttons ?? 0;
        const clickCount = params.clickCount ?? 0;
        if (!MouseButtons.has(button) || !wholeIn(buttons, 0, 7) || !wholeIn(clickCount, 0, 3)) {
            return null;
        }
        out.button = button;
        out.buttons = buttons;
        out.clickCount = clickCount;
        if (type === "mouseWheel") {
            const deltaX = params.deltaX ?? 0;
            const deltaY = params.deltaY ?? 0;
            if (!finiteNumber(deltaX) || !finiteNumber(deltaY)) {
                return null;
            }
            if (Math.abs(deltaX) > MaxWheelDelta || Math.abs(deltaY) > MaxWheelDelta) {
                return null;
            }
            out.deltaX = deltaX;
            out.deltaY = deltaY;
        }
        return out;
    }
    if (method === "Input.dispatchKeyEvent") {
        const { type, key, code } = params ?? {};
        if (!KeyEventTypes.has(type) || !shortString(key, MaxKeyField) || !shortString(code ?? "", MaxKeyField)) {
            return null;
        }
        const keyCode = params.windowsVirtualKeyCode ?? 0;
        if (!wholeIn(keyCode, 0, 255)) {
            return null;
        }
        if (isClipboardChord(key, code ?? "", modifiers)) {
            return null;
        }
        const out: any = { type, key, code: code ?? "", windowsVirtualKeyCode: keyCode, modifiers };
        for (const field of ["text", "unmodifiedText"]) {
            if (params[field] == null) {
                continue;
            }
            if (!shortString(params[field], 8)) {
                return null;
            }
            out[field] = params[field];
        }
        if (Array.isArray(params.commands)) {
            const commands = params.commands.filter(
                (c: unknown) => typeof c === "string" && AllowedEditingCommands.has(c)
            );
            if (commands.length > 0) {
                out.commands = commands;
            }
        }
        return out;
    }
    return null;
}

const MinViewportSide = 100;
const MaxViewportSide = 4096;

// Emulation.setDeviceMetricsOverride for resize: a bounded size, the panel's own scale, never a mobile emulation.
export function sanitizeEmulationParams(params: any): {
    width: number;
    height: number;
    deviceScaleFactor: 0;
    mobile: false;
} {
    const { width, height } = params ?? {};
    if (!wholeIn(width, MinViewportSide, MaxViewportSide) || !wholeIn(height, MinViewportSide, MaxViewportSide)) {
        return null;
    }
    return { width, height, deviceScaleFactor: 0, mobile: false };
}

// What emain dispatched itself and what it then sees: a mouse press with its button and point (CSS pixels), or a key
// down with its key and code.
export type InputSignature =
    | { kind: "mouse"; button: string; x: number; y: number }
    | { kind: "key"; key: string; code: string };

export type InputChannel = "native" | "page";

type LedgerEntry = { seq: number; at: number; signature: InputSignature; claimed: Set<InputChannel> };

// An entry the page never reports (input into a frame, a page that stopped it) is forgotten after this long; it never
// covers anything but its own match.
export const SyntheticInputExpiryMs = 2000;
const PointTolerance = 2;

function signaturesMatch(expected: InputSignature, seen: InputSignature, zoom: number): boolean {
    if (expected.kind === "mouse" && seen.kind === "mouse") {
        if (expected.button !== seen.button) {
            return false;
        }
        const near = (a: number, b: number) =>
            Math.abs(a - b) <= PointTolerance || Math.abs(a / (zoom || 1) - b) <= PointTolerance;
        return near(seen.x, expected.x) && near(seen.y, expected.y);
    }
    if (expected.kind === "key" && seen.kind === "key") {
        if (expected.key !== seen.key) {
            return false;
        }
        return expected.code === "" || seen.code === "" || expected.code === seen.code;
    }
    return false;
}

// Takeover by sequence (FR-BRW-008 AC7, FR-BRW-010): each input the agent dispatches gets a sequence number. The
// native observer (before-input-event, before-mouse-event) and the page observer (the preload) each claim the oldest
// unclaimed entry that matches what they see, once; input that matches no entry is the user's, even while the agent
// is typing. No time window lets the user's own click through as the agent's.
export class SyntheticInputLedger {
    entries = new Map<number, LedgerEntry[]>();
    nextSeq = 1;

    expect(wcId: number, signature: InputSignature, now: number): number {
        const list = this.prune(wcId, now);
        const seq = this.nextSeq++;
        list.push({ seq, at: now, signature, claimed: new Set() });
        this.entries.set(wcId, list);
        return seq;
    }

    claim(wcId: number, channel: InputChannel, seen: InputSignature, now: number, zoom = 1): boolean {
        const list = this.prune(wcId, now);
        const entry = list.find((e) => !e.claimed.has(channel) && signaturesMatch(e.signature, seen, zoom));
        if (entry == null) {
            return false;
        }
        entry.claimed.add(channel);
        if (entry.claimed.size >= 2) {
            list.splice(list.indexOf(entry), 1);
        }
        return true;
    }

    pending(wcId: number, now: number): number {
        return this.prune(wcId, now).length;
    }

    forget(wcId: number): void {
        this.entries.delete(wcId);
    }

    prune(wcId: number, now: number): LedgerEntry[] {
        const list = (this.entries.get(wcId) ?? []).filter((e) => now - e.at < SyntheticInputExpiryMs);
        if (list.length === 0) {
            this.entries.delete(wcId);
        } else {
            this.entries.set(wcId, list);
        }
        return list;
    }
}

// The signature an Input.* call will produce in the page, for the events that take over: presses and key downs.
export function expectedSignature(method: string, params: any): InputSignature {
    if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        return { kind: "mouse", button: params.button, x: params.x, y: params.y };
    }
    if (method === "Input.dispatchKeyEvent" && (params?.type === "keyDown" || params?.type === "rawKeyDown")) {
        return { kind: "key", key: params.key, code: params.code ?? "" };
    }
    return null;
}

const ElectronButtons: Record<string, string> = { left: "left", middle: "middle", right: "right" };
const DomButtons = ["left", "middle", "right"];

export function nativeMouseSignature(mouse: any): InputSignature {
    return {
        kind: "mouse",
        button: ElectronButtons[mouse?.button] ?? "none",
        x: finiteNumber(mouse?.x) ? mouse.x : -1,
        y: finiteNumber(mouse?.y) ? mouse.y : -1,
    };
}

export function nativeKeySignature(input: any): InputSignature {
    return { kind: "key", key: String(input?.key ?? ""), code: String(input?.code ?? "") };
}

// The preload's report (emain/preload-webview.ts); null when it is not one, which counts as the user's input.
export function pageSignature(report: any): InputSignature {
    if (report?.type === "mousedown" && Number.isInteger(report.button)) {
        if (!finiteNumber(report.x) || !finiteNumber(report.y)) {
            return null;
        }
        return { kind: "mouse", button: DomButtons[report.button] ?? "none", x: report.x, y: report.y };
    }
    if (report?.type === "keydown" && shortString(report.key, 64) && shortString(report.code ?? "", 64)) {
        return { kind: "key", key: report.key, code: report.code ?? "" };
    }
    return null;
}

export type InspectParams = {
    backendNodeId?: number;
    point?: { x: number; y: number };
    focused?: boolean;
    lean?: boolean;
};

export function inspectParams(params: any): InspectParams {
    if (params?.focused === true) {
        return params.lean === true ? { focused: true, lean: true } : { focused: true };
    }
    if (Number.isInteger(params?.backendnodeid) && params.backendnodeid > 0) {
        return { backendNodeId: params.backendnodeid };
    }
    if (finiteNumber(params?.x) && finiteNumber(params?.y) && params.x >= 0 && params.y >= 0) {
        if (params.x > MaxCoordinate || params.y > MaxCoordinate) {
            return null;
        }
        return { point: { x: params.x, y: params.y } };
    }
    return null;
}

export type SetFieldParams = { backendNodeId: number; value: string | number | boolean };

export function setFieldParams(params: any): SetFieldParams {
    const value = params?.value;
    if (!Number.isInteger(params?.backendnodeid) || params.backendnodeid <= 0) {
        return null;
    }
    if (typeof value === "string" ? value.length > MaxInsertText : typeof value !== "boolean" && !finiteNumber(value)) {
        return null;
    }
    return { backendNodeId: params.backendnodeid, value };
}

// The fixed function Molten.inspect runs on an element in MoltenTerm's isolated world: the page's scripts cannot
// change what it reads. It says what the element is for the sensitive-action rules (DS-BRW-016) and the bar's line,
// never a field's value. Must match targetInfo in pkg/molten/browseragent/sensitive.go. With lean set (a key that
// types a character) it skips the label, the box and the form, which cost a layout on every key.
// Types are checked through the element's own window, never this world's constructors: an element of a same-origin
// frame comes from another realm, where instanceof would say it is no field at all and nothing would ask.
export const InspectElementSource = `(el, lean) => {
    const SensitiveAutocomplete = /(^|\\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\\s|$)/i;
    const CardName = /(card.?num|cc.?num|cc-?number|credit.?card|cvc|cvv|csc|card.?code|security.?code|card.?verif)/i;
    const SecretName = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd|otp|pin(code)?)([^a-z]|$)/i;
    const TextTypes = new Set(["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "time", "week"]);
    if (el == null || el.nodeType !== 1) {
        return { found: false, kind: "element" };
    }
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const tagOf = (e) => (e && e.nodeType === 1 ? String(e.tagName).toLowerCase() : "");
    const isInput = (e) => tagOf(e) === "input";
    const isField = (e) => isInput(e) || tagOf(e) === "textarea";
    // Fields seen as passwords keep counting as one after a "show password" toggle made them text.
    const seenKey = "__moltentermSecretFields";
    const seen = globalThis[seenKey] || (globalThis[seenKey] = new WeakSet());
    try {
        for (const f of doc.querySelectorAll("input[type=password]")) {
            seen.add(f);
        }
    } catch {}
    const sensitive = (f) => {
        if (!isField(f)) {
            return false;
        }
        if ((f.getAttribute("type") || "").toLowerCase() === "password" || seen.has(f)) {
            return true;
        }
        if (SensitiveAutocomplete.test(f.getAttribute("autocomplete") || "")) {
            return true;
        }
        const names = ((f.getAttribute("name") || "") + " " + (f.getAttribute("id") || "")).replace(/([a-z])([A-Z])/g, "$1 $2");
        if (CardName.test(names) || SecretName.test(names)) {
            return true;
        }
        try {
            const masked = win.getComputedStyle(f).webkitTextSecurity;
            return Boolean(masked) && masked !== "none";
        } catch {
            return false;
        }
    };
    const tag = tagOf(el);
    if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") {
        const r = el.getBoundingClientRect();
        return { found: true, kind: "frame", frame: true, label: el.getAttribute("title") || "", rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    const target = el.closest("a[href], button, input, select, textarea, label, [role=button], [role=link], [contenteditable=''], [contenteditable=true]") || el;
    const t = tagOf(target);
    const type = t === "input" ? (target.getAttribute("type") || "text").toLowerCase() : "";
    let control = target;
    if (t === "label" && target.control) {
        control = target.control;
    }
    const ctag = tagOf(control);
    const ctype = ctag === "input" ? String(control.type || "").toLowerCase() : "";
    const fileInput = ctag === "input" && ctype === "file";
    const editable = ctag === "textarea" || (ctag === "input" && TextTypes.has(ctype)) || Boolean(target.isContentEditable);
    let kind = "element";
    if (fileInput) {
        kind = "file";
    } else if (t === "a" || target.getAttribute("role") === "link") {
        kind = "link";
    } else if (ctag === "button" || target.getAttribute("role") === "button" || ["button", "submit", "reset", "image"].includes(ctype || type)) {
        kind = "button";
    } else if (ctype === "checkbox") {
        kind = "checkbox";
    } else if (ctype === "radio") {
        kind = "radio";
    } else if (ctag === "select") {
        kind = "select";
    } else if (editable) {
        kind = "textbox";
    }
    if (lean) {
        return { found: true, kind, sensitive: sensitive(control), editable, fileinput: fileInput, frame: false };
    }
    const form = control.form || target.closest("form");
    let scope = form != null ? Array.from(form.elements || []) : [];
    // A sign-in without a form element (a script sends it): the nearest few containers stand for the form, never the
    // whole page, where any button would ask.
    if (form == null && kind === "button") {
        let up = target.parentElement;
        for (let i = 0; i < 6 && up != null && up !== doc.body && up !== doc.documentElement && scope.length === 0; i++, up = up.parentElement) {
            const fields = Array.from(up.querySelectorAll("input, textarea"));
            if (fields.some(sensitive)) {
                scope = fields;
            }
        }
    }
    const formSensitive = scope.some(sensitive);
    // Any button of a form holding a sensitive field may send it, from script as well as as a submit button.
    const submitControl = kind === "button" && ctype !== "reset" && formSensitive;
    const text = (e) => (e && typeof e.innerText === "string" ? e.innerText : "");
    let label = control.getAttribute("aria-label") || target.getAttribute("aria-label") || "";
    if (!label && control.labels && control.labels.length > 0) {
        label = text(control.labels[0]);
    }
    if (!label) {
        label = control.getAttribute("placeholder") || target.getAttribute("title") || target.getAttribute("alt") || "";
    }
    if (!label && kind !== "textbox" && kind !== "select") {
        label = ["button", "submit", "reset"].includes(type) ? target.getAttribute("value") || "" : text(target);
    }
    const r = target.getBoundingClientRect();
    return {
        found: true,
        kind,
        label: String(label).slice(0, 200),
        sensitive: sensitive(control),
        editable,
        submitcontrol: submitControl,
        formsensitive: formSensitive,
        fileinput: fileInput,
        frame: false,
        link: target.closest("a[href]") != null,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
}`;

// The element under a point, through open shadow roots; a same-origin frame's own element is not looked into.
export function inspectPointScript(x: number, y: number): string {
    return `(() => {
    let el = document.elementFromPoint(${Number(x)}, ${Number(y)});
    while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === "function") {
        const inner = el.shadowRoot.elementFromPoint(${Number(x)}, ${Number(y)});
        if (inner == null || inner === el) {
            break;
        }
        el = inner;
    }
    return (${InspectElementSource})(el, false);
})()`;
}

// The focused element, through open shadow roots and same-origin frames; the page's body counts as no field.
export function inspectFocusedScript(lean: boolean): string {
    return `(() => {
    let el = document.activeElement;
    for (let i = 0; i < 20 && el; i++) {
        if (el.shadowRoot && el.shadowRoot.activeElement) {
            el = el.shadowRoot.activeElement;
            continue;
        }
        let inner = null;
        try {
            inner = el.contentDocument ? el.contentDocument.activeElement : null;
        } catch {
            inner = null;
        }
        if (inner && inner !== el.contentDocument.body) {
            el = inner;
            continue;
        }
        break;
    }
    if (el == null || el === document.body || el === document.documentElement || el === (el.ownerDocument && el.ownerDocument.body)) {
        return { found: false, kind: "element" };
    }
    return (${InspectElementSource})(el, ${lean ? "true" : "false"});
})()`;
}

export const InspectFocusedScript = inspectFocusedScript(false);

// The fixed function form_input runs on its field in MoltenTerm's isolated world: it sets the value, the checked
// state or the option, then fires input and change so the page's own code sees the change.
export const SetFieldSource = `function (value) {
    const el = this;
    if (el == null || !el.isConnected) {
        return { ok: false, error: "gone" };
    }
    const fire = () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (el instanceof HTMLSelectElement) {
        const want = String(value);
        const options = Array.from(el.options);
        const option = options.find((o) => o.value === want) || options.find((o) => o.text.trim() === want.trim());
        if (option == null) {
            return { ok: false, error: "option" };
        }
        option.selected = true;
        fire();
        return { ok: true };
    }
    if (el instanceof HTMLInputElement) {
        const type = el.type;
        if (type === "file") {
            return { ok: false, error: "file" };
        }
        if (type === "checkbox" || type === "radio") {
            el.checked = value === true || value === 1 || ["true", "on", "1", "checked", "yes"].includes(String(value).toLowerCase());
            fire();
            return { ok: true };
        }
        if (["button", "submit", "reset", "image", "hidden"].includes(type)) {
            return { ok: false, error: "unsupported" };
        }
        el.focus();
        el.value = String(value);
        fire();
        return { ok: true };
    }
    if (el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = String(value);
        fire();
        return { ok: true };
    }
    return { ok: false, error: "unsupported" };
}`;

// The host a download comes from, for the confirmation; "" for a URL without one (blob:, data:).
export function downloadHost(url: string): string {
    try {
        const u = new URL(url);
        if (u.protocol === "blob:") {
            return downloadHost(u.pathname);
        }
        return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : "";
    } catch {
        return "";
    }
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
