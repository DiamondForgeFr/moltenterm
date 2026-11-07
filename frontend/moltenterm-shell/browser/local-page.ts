// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Local and inline pages in the browser panel (FR-BRW-014, #1978). A page of `file:` or `data:` runs script next to
// this computer's files, and a terminal or an agent can queue one in a panel (wsh web open, molten open, a block
// created with a url, a page queued in the panel's meta). Such a tab does not load until the user says so, in the tab
// itself. Pure: the panel applies it, and nothing here blocks: every page opens with one click.
//
// A tab is allowed when the user typed its address, answered Open, or the file is remembered in browser:localpages.
// The allowance is saved with the tab (BrowserTab.allowed in the panel's saved tabs, a meta key a terminal cannot
// write), so a restart does not ask again.

import base64 from "base64-js";

// must match ConfigKey_BrowserLocalPages in pkg/wconfig/metaconsts.go
export const LocalPagesKey = "browser:localpages";
export const LocalPageAllow = "allow";

export const LocalFile = "file";
export const LocalData = "data";

// The file path or the start of the inline page a question shows is cut here.
const ShownPathMax = 300;
const ShownStartMax = 160;
const ShownHalf = 140;
const Base64Re = /^[A-Za-z0-9+/_-]*={0,2}$/;

export type LocalPages = Record<string, string>;

// file: path is the absolute path on this computer (a network location keeps its host in front: //host/share/x).
// data: mediaType, the start of the content and its length.
export type LocalPage = {
    kind: string;
    path?: string;
    mediaType?: string;
    start?: string;
    length?: number;
};

// The address a webview tag resolves a scheme-less src against is the app page's own: a packaged app's is a file.
function appBase(): string {
    return typeof document !== "undefined" && document.baseURI ? document.baseURI : "file:///";
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function filePathOf(u: URL): string {
    const path = safeDecode(u.pathname);
    if (u.hostname !== "" && u.hostname !== "localhost") {
        return "//" + u.hostname + path;
    }
    return /^\/[A-Za-z]:[/\\]/.test(path) ? path.slice(1) : path;
}

function dataStart(header: string, payload: string): string {
    if (/;\s*base64$/i.test(header)) {
        const chunk = payload.slice(0, ShownStartMax * 2);
        const whole = chunk.slice(0, chunk.length - (chunk.length % 4));
        if (!Base64Re.test(whole)) {
            return payload.slice(0, ShownStartMax);
        }
        try {
            return new TextDecoder().decode(base64.toByteArray(whole)).slice(0, ShownStartMax);
        } catch {
            return payload.slice(0, ShownStartMax);
        }
    }
    return safeDecode(payload.slice(0, ShownStartMax * 3)).slice(0, ShownStartMax);
}

function dataPageOf(href: string): LocalPage {
    const rest = href.slice("data:".length);
    const comma = rest.indexOf(",");
    const header = comma < 0 ? rest : rest.slice(0, comma);
    const payload = comma < 0 ? "" : rest.slice(comma + 1);
    const mediaType = header.split(";")[0].trim().toLowerCase() || "text/plain";
    return { kind: LocalData, mediaType, start: dataStart(header, payload), length: payload.length };
}

// The local page an address opens, null for any other address. The address is read as the webview tag reads it:
// the URL parser drops tabs and line breaks (da\nta: is data:), ignores case and surrounding spaces, and an address
// without a scheme is relative to the app page.
export function localPageOf(url: string, base: string = appBase()): LocalPage {
    const text = String(url ?? "").trim();
    if (text === "") {
        return null;
    }
    let u: URL;
    try {
        u = new URL(text, base);
    } catch {
        return null;
    }
    if (u.protocol === "file:") {
        return { kind: LocalFile, path: filePathOf(u) };
    }
    if (u.protocol === "data:") {
        return dataPageOf(u.href);
    }
    return null;
}

export function isLocalPage(url: string, base?: string): boolean {
    return localPageOf(url, base) != null;
}

// A remembered file opens without a question in any panel. Only a file can be remembered: an inline page has no
// place to name.
export function canRememberLocalPage(page: LocalPage): boolean {
    return page?.kind === LocalFile && page.path !== "";
}

export function isRememberedLocalPage(page: LocalPage, remembered: LocalPages): boolean {
    return (
        canRememberLocalPage(page) &&
        remembered != null &&
        typeof remembered === "object" &&
        Object.prototype.hasOwnProperty.call(remembered, page.path) &&
        remembered[page.path] === LocalPageAllow
    );
}

// The setting once the user chose "Always open this file".
export function withRememberedLocalPage(remembered: LocalPages, page: LocalPage): LocalPages {
    if (!canRememberLocalPage(page)) {
        return remembered ?? null;
    }
    const next: LocalPages = {};
    for (const [path, decision] of Object.entries(remembered ?? {})) {
        if (typeof decision === "string") {
            next[path] = decision;
        }
    }
    next[page.path] = LocalPageAllow;
    return next;
}

export type LocalTab = { url: string; engine?: string; allowed?: boolean };

// Whether the tab holds back its page and asks: a page of this panel (not a handed-off entry) that is local and that
// the user neither typed, allowed nor remembered.
export function needsLocalAsk(tab: LocalTab, remembered: LocalPages, base?: string): boolean {
    if (tab == null || tab.engine || tab.allowed === true) {
        return false;
    }
    const page = localPageOf(tab.url, base);
    return page != null && !isRememberedLocalPage(page, remembered);
}

// The patch for a tab whose mounted page navigated to url: that page was let in when it mounted, so a local page it
// reaches stays allowed instead of unloading the tab under the user.
export function allowedWhenNavigated(tab: LocalTab, url: string, base?: string): { allowed?: boolean } {
    if (tab?.allowed === true || !isLocalPage(url, base)) {
        return {};
    }
    return { allowed: true };
}

// C0 and C1 controls, the left-to-right and right-to-left marks, the embedding and override controls (U+202A to
// U+202E) and the isolates (U+2066 to U+2069).
function isHiddenChar(code: number): boolean {
    return (
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
    );
}

// A path or an inline page's start, as the question draws it: control and direction-changing characters (an
// overriding right-to-left mark can make a path read as another) become visible escapes, and a long text keeps both
// ends.
export function displayLocalText(text: string, max: number = ShownPathMax): string {
    const safe = Array.from(String(text ?? ""))
        .map((c) => (isHiddenChar(c.charCodeAt(0)) ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0") : c))
        .join("");
    if (safe.length <= max) {
        return safe;
    }
    const half = Math.min(ShownHalf, Math.floor((max - 3) / 2));
    return safe.slice(0, half) + " … " + safe.slice(safe.length - half);
}
