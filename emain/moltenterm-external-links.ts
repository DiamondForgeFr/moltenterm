// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The one rule for links MoltenTerm hands to the system (#663): open-external from the renderers, Wave's navigation
// and window-open fallbacks, and a page's request to launch an app. A link's text can say https://… while it points
// at file:///Volumes/share/x.app or an app's own scheme (OSC 8 links from a remote host, agent markdown), so only web
// pages and mail open at once; a local file is shown in its folder, never run; any other scheme asks first, naming
// the target; schemes that only make sense inside a page are dropped.

import * as electron from "electron";
import { fileURLToPath } from "url";
import { callWithOriginalXdgCurrentDesktopAsync } from "./emain-platform";
import { mt } from "./moltenterm-i18n";

export const ExternalOpen = "open";
export const ExternalShowInFolder = "showinfolder";
export const ExternalConfirm = "confirm";
export const ExternalDrop = "drop";

const OpenSchemes = ["http:", "https:", "mailto:"];
const DroppedSchemes = ["javascript:", "data:", "blob:", "about:", "vbscript:", "view-source:", "chrome:", "devtools:"];
// A dialog shows this much of the target: enough to recognise it, never a wall of text.
const ShownTargetMax = 300;

export type ExternalLinkAction = { action: string; url?: string; path?: string; scheme?: string };

export function externalLinkAction(raw: unknown): ExternalLinkAction {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { action: ExternalDrop };
    }
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return { action: ExternalDrop };
    }
    const scheme = u.protocol.toLowerCase();
    if (OpenSchemes.includes(scheme)) {
        if (scheme !== "mailto:" && u.hostname === "") {
            return { action: ExternalDrop };
        }
        return { action: ExternalOpen, url: u.toString() };
    }
    if (scheme === "file:") {
        // A file on another host (file://server/share) is a network mount the system would reach for us.
        if (u.hostname !== "" && u.hostname !== "localhost") {
            return { action: ExternalDrop };
        }
        try {
            return { action: ExternalShowInFolder, path: fileURLToPath(u) };
        } catch {
            return { action: ExternalDrop };
        }
    }
    if (DroppedSchemes.includes(scheme)) {
        return { action: ExternalDrop };
    }
    return { action: ExternalConfirm, url: u.toString(), scheme: scheme.replace(/:$/, "") };
}

export function shownTarget(url: string): string {
    return url.length > ShownTargetMax ? url.slice(0, ShownTargetMax) + "…" : url;
}

function hostWindow(sender: electron.WebContents): electron.BrowserWindow {
    if (sender == null || sender.isDestroyed()) {
        return null;
    }
    // A webview guest's own window is its host's; a tab view has no BrowserWindow of its own.
    const owner = sender.hostWebContents ?? sender;
    return electron.BrowserWindow.fromWebContents(owner) ?? electron.BrowserWindow.getFocusedWindow() ?? null;
}

async function confirmOpen(target: ExternalLinkAction, parent: electron.BrowserWindow): Promise<boolean> {
    const options: electron.MessageBoxOptions = {
        type: "question",
        message: mt("dialog.openExternal.message", { scheme: target.scheme }),
        detail: mt("dialog.openExternal.detail", { url: shownTarget(target.url), scheme: target.scheme }),
        buttons: [mt("common.cancel"), mt("dialog.openExternal.open")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
    const result =
        parent != null && !parent.isDestroyed()
            ? await electron.dialog.showMessageBox(parent, options)
            : await electron.dialog.showMessageBox(options);
    return result.response === 1;
}

function openNow(url: string): Promise<void> {
    return callWithOriginalXdgCurrentDesktopAsync(() =>
        electron.shell.openExternal(url).catch((err) => {
            console.log("open-external failed", url, err);
        })
    );
}

// Applies the rule; resolves to whether something was opened or shown.
export async function openExternalLink(raw: unknown, sender?: electron.WebContents): Promise<boolean> {
    const target = externalLinkAction(raw);
    switch (target.action) {
        case ExternalOpen:
            await openNow(target.url);
            return true;
        case ExternalShowInFolder:
            electron.shell.showItemInFolder(target.path);
            return true;
        case ExternalConfirm: {
            if (!(await confirmOpen(target, hostWindow(sender)))) {
                console.log("open-external declined", target.scheme);
                return false;
            }
            await openNow(target.url);
            return true;
        }
        default:
            console.log("open-external dropped", typeof raw === "string" ? shownTarget(raw) : typeof raw);
            return false;
    }
}

// A page's request to launch an app (the openExternal permission, e.g. a zoommtg: link): web pages and mail pass,
// any other scheme asks as above, local files and page-only schemes are refused.
export async function allowPageExternalLaunch(raw: unknown, sender: electron.WebContents): Promise<boolean> {
    const target = externalLinkAction(raw);
    if (target.action === ExternalOpen) {
        return true;
    }
    if (target.action !== ExternalConfirm) {
        return false;
    }
    return confirmOpen(target, hostWindow(sender));
}
