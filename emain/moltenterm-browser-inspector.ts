// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The web page panel's inspector and site data in emain (FR-BRW-022, DS-BRW-027).
//
// The docked developer tools are a WebContentsView, a child of the Wave tab view that holds the panel, set as the page's
// DevTools contents: a <webview> cannot host them (Chromium binds the tools to the guest's previous frame when their
// page loads in a new process, and they stay unconnected). The panel draws the pane and sends the rectangle the view
// covers; the view hides when the window says so (a modal, a surface over the pane, a page not shown).
//
// The DevTools frontend and the agents' webContents.debugger are separate clients of the page (DS-BRW-012): neither
// stops the other.

import { WebContentsView, type WebContents } from "electron";
import { browserKeyAction, BrowserKeyInspect } from "../frontend/moltenterm-shell/browser/browser-keys";
import { adaptFromElectronKeyEvent } from "../frontend/util/keyutil";
import {
    ClearCacheKind,
    ClearSiteKind,
    cookiesToRestore,
    cookieUrl,
    inspectPoint,
    ownCookies,
    placeBounds,
    restoreDetails,
    siteOriginOf,
    SiteStorages,
} from "./moltenterm-browser-inspector-policy";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { liveWebContentsFromId } from "./moltenterm-webcontents-id";

export const InspectorOpenChannel = "moltenterm-inspector-open";
export const InspectorPlaceChannel = "moltenterm-inspector-place";
export const InspectorCloseChannel = "moltenterm-inspector-close";
export const InspectorWindowChannel = "moltenterm-inspector-window";
// Sent to the window when a page's docked tools went away by themselves (the page closed or crashed).
export const InspectorGoneChannel = "moltenterm-inspector-gone";
export const ClearDataChannel = "moltenterm-browser-clear-data";
// Wave's channel for a key held back from a page (emain-ipc.ts): the panel holding the page answers it.
const ReinjectKeyChannel = "reinject-key";

// How long a closing view may take to go before the next open or the separate window gives up: past it, setting
// another one could reach the tools' released contents.
const ViewGoneMs = 10000;

type ParentView = { addChildView(view: WebContentsView): void; removeChildView(view: WebContentsView): void };

export type InspectorDeps = {
    // The Wave tab view whose page is `host`, which the docked tools sit in.
    parentOf: (host: WebContents) => ParentView;
    // A web address the tools open (a link in the Network panel): a page beside the panel.
    openLink: (url: string, host: WebContents) => void;
    mac: boolean;
};

export type ClearResult = { ok: boolean; reason?: "gone" | "moved" | "failed"; error?: string };

type Inspector = {
    page: WebContents;
    host: WebContents;
    parent: ParentView;
    view: WebContentsView;
    // Removes the listeners set on the page and the window for this view.
    release: () => void;
};

const inspectors = new Map<number, Inspector>();
const closing = new Map<number, Promise<boolean>>();
let deps: InspectorDeps = null;

// A page whose developer tools are docked: the hidden-page freeze and discard (#459) leave it alone, as one whose
// DevTools window is open.
export function isInspected(pageId: number): boolean {
    return inspectors.has(pageId);
}

function ownedPage(host: WebContents, pageId: unknown): WebContents {
    const page = liveWebContentsFromId(pageId);
    if (page == null || page.getType() !== "webview" || page.hostWebContents?.id !== host?.id) {
        return null;
    }
    return page;
}

function place(insp: Inspector, raw: unknown): void {
    const placed = placeBounds(raw, insp.host.isDestroyed() ? 1 : insp.host.getZoomFactor());
    if (placed == null) {
        return;
    }
    insp.view.setBounds(placed.bounds);
    insp.view.setVisible(placed.visible);
}

// Chromium hit-tests a guest's point in its embedder's coordinates: the window sends the right-click's point in its own
// CSS pixels (where it drew the menu), and the window's zoom makes them DIP.
function inspectAt(page: WebContents, host: WebContents, raw: unknown): void {
    const point = inspectPoint(raw, host.isDestroyed() ? 1 : host.getZoomFactor());
    if (point != null) {
        page.inspectElement(point.x, point.y);
    }
}

// Resolves true once the view is destroyed and one more task has run: Electron lets go of the page's DevTools contents
// after the destroyed listeners, and setting another one or opening the window before that crashes the app.
function closeInspector(pageId: number, tellWindow: boolean): Promise<boolean> {
    const insp = inspectors.get(pageId);
    if (insp == null) {
        return closing.get(pageId) ?? Promise.resolve(true);
    }
    inspectors.delete(pageId);
    insp.release();
    const contents = insp.view.webContents;
    const gone = new Promise<boolean>((resolve) => {
        if (contents == null || contents.isDestroyed()) {
            resolve(true);
            return;
        }
        const timer = setTimeout(() => resolve(false), ViewGoneMs);
        contents.once("destroyed", () =>
            setTimeout(() => {
                clearTimeout(timer);
                resolve(true);
            }, 0)
        );
    });
    try {
        if (!insp.page.isDestroyed()) {
            insp.page.closeDevTools();
        }
    } catch (e) {
        console.log("molten inspector: closing the tools failed", e);
    }
    try {
        insp.parent.removeChildView(insp.view);
    } catch (e) {
        console.log("molten inspector: removing the view failed", e);
    }
    if (contents != null && !contents.isDestroyed()) {
        contents.close();
    }
    const done = gone.finally(() => {
        if (closing.get(pageId) === done) {
            closing.delete(pageId);
        }
    });
    closing.set(pageId, done);
    if (tellWindow && !insp.host.isDestroyed()) {
        insp.host.send(InspectorGoneChannel, pageId);
    }
    return done;
}

function watchTools(page: WebContents, host: WebContents, contents: WebContents): void {
    // The tools keep their own keys (⌘F, ⌘R, ⌘[ ⌘], Escape...); only the inspect toggle goes back to the panel.
    contents.on("before-input-event", (e, input) => {
        if (
            input.type !== "keyDown" ||
            browserKeyAction(adaptFromElectronKeyEvent(input), deps.mac) !== BrowserKeyInspect
        ) {
            return;
        }
        e.preventDefault();
        if (!host.isDestroyed()) {
            host.send(ReinjectKeyChannel, adaptFromElectronKeyEvent(input), page.id);
        }
    });
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url ?? "")) {
            deps.openLink(url, host);
        }
        return { action: "deny" };
    });
    // The tools navigate by the main process only; a link inside them never takes their place.
    contents.on("will-navigate", (e, url) => {
        if (!/^devtools:/i.test(url ?? "")) {
            e.preventDefault();
        }
    });
}

async function openInspector(
    host: WebContents,
    pageId: unknown,
    rawPlace: unknown,
    rawPoint: unknown
): Promise<boolean> {
    const page = ownedPage(host, pageId);
    const parent = page == null ? null : deps.parentOf(host);
    if (page == null || parent == null) {
        return false;
    }
    const existing = inspectors.get(page.id);
    if (existing != null) {
        place(existing, rawPlace);
        inspectAt(page, host, rawPoint);
        return true;
    }
    if (!(await (closing.get(page.id) ?? Promise.resolve(true)))) {
        return false;
    }
    if (page.isDestroyed() || host.isDestroyed()) {
        return false;
    }
    // Two opens raced while a view was going: the first one made the new view.
    const raced = inspectors.get(page.id);
    if (raced != null) {
        place(raced, rawPlace);
        inspectAt(page, host, rawPoint);
        return true;
    }
    // The tools in their own window move into the panel.
    if (page.isDevToolsOpened()) {
        page.closeDevTools();
    }
    const view = new WebContentsView({
        webPreferences: { session: page.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.setVisible(false);
    const id = page.id;
    const onPageGone = () => void closeInspector(id, true);
    const onOpenUrl = (_e: Electron.Event, url: string) => {
        if (/^https?:/i.test(url ?? "")) {
            deps.openLink(url, host);
        }
    };
    const insp: Inspector = {
        page,
        host,
        parent,
        view,
        release: () => {
            if (!page.isDestroyed()) {
                page.off("destroyed", onPageGone);
                page.off("render-process-gone", onPageGone);
                page.off("devtools-open-url", onOpenUrl);
            }
            if (!host.isDestroyed()) {
                host.off("destroyed", onPageGone);
            }
        },
    };
    inspectors.set(id, insp);
    page.once("destroyed", onPageGone);
    page.once("render-process-gone", onPageGone);
    page.on("devtools-open-url", onOpenUrl);
    host.once("destroyed", onPageGone);
    parent.addChildView(view);
    place(insp, rawPlace);
    watchTools(page, host, view.webContents);
    page.setDevToolsWebContents(view.webContents);
    page.openDevTools({ mode: "detach", activate: false });
    inspectAt(page, host, rawPoint);
    // Inspect is asked for: the keyboard goes to the tools, as in a browser.
    view.webContents.once("did-finish-load", () => {
        if (inspectors.get(id) === insp && !view.webContents.isDestroyed()) {
            view.webContents.focus();
        }
    });
    return true;
}

async function openToolsWindow(host: WebContents, pageId: unknown): Promise<boolean> {
    const page = ownedPage(host, pageId);
    if (page == null) {
        return false;
    }
    if (!(await closeInspector(page.id, true)) || page.isDestroyed()) {
        return false;
    }
    page.openDevTools({ mode: "detach", activate: true });
    return true;
}

async function clearHostCookies(ses: Electron.Session, host: string): Promise<void> {
    const own = ownCookies(await ses.cookies.get({ domain: host }), host);
    if (own.length === 0) {
        return;
    }
    const names = [...new Set(own.map((c) => c.name))];
    const sameNamed = async () => (await Promise.all(names.map((name) => ses.cookies.get({ name })))).flat();
    const before = await sameNamed();
    for (const cookie of own) {
        await ses.cookies.remove(cookieUrl(cookie), cookie.name);
    }
    for (const cookie of cookiesToRestore(before, await sameNamed(), host)) {
        await ses.cookies
            .set(restoreDetails(cookie))
            .catch((e) => console.log("molten site data: a parent domain's cookie could not be set back", e));
    }
}

// Clear this site's data (the page's origin only) or the browser cache (the panel's session), then reload the page.
export async function clearPageData(
    host: WebContents,
    pageId: unknown,
    kind: unknown,
    origin: unknown
): Promise<ClearResult> {
    const page = ownedPage(host, pageId);
    if (page == null) {
        return { ok: false, reason: "gone" };
    }
    const ses = page.session;
    try {
        if (kind === ClearCacheKind) {
            await ses.clearCache();
            page.reload();
            return { ok: true };
        }
        if (kind !== ClearSiteKind) {
            return { ok: false, reason: "failed", error: "unknown data kind" };
        }
        // The developer confirmed one origin: a page that moved meanwhile clears nothing.
        const site = siteOriginOf(page.getURL());
        if (site == null || site.origin !== origin) {
            return { ok: false, reason: "moved" };
        }
        await ses.clearStorageData({ origin: site.origin, storages: [...SiteStorages] });
        await ses.clearData({ dataTypes: ["cache"], origins: [site.origin] });
        await clearHostCookies(ses, site.host);
        page.reload();
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
}

export function initMoltentermBrowserInspector(d: InspectorDeps): void {
    deps = d;
    handleAppIpc(InspectorOpenChannel, (event, pageId, rawPlace, rawPoint) =>
        openInspector(event.sender, pageId, rawPlace, rawPoint)
    );
    onAppIpc(InspectorPlaceChannel, (event, pageId, rawPlace) => {
        const insp = inspectors.get(pageId);
        if (insp != null && insp.host.id === event.sender.id) {
            place(insp, rawPlace);
        }
    });
    handleAppIpc(InspectorCloseChannel, async (event, pageId) => {
        const insp = inspectors.get(pageId);
        if (insp != null && insp.host.id !== event.sender.id) {
            return false;
        }
        return closeInspector(pageId, false);
    });
    handleAppIpc(InspectorWindowChannel, (event, pageId) => openToolsWindow(event.sender, pageId));
    handleAppIpc(ClearDataChannel, (event, pageId, kind, origin) => clearPageData(event.sender, pageId, kind, origin));
}
