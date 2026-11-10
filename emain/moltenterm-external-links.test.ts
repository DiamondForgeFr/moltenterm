// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({
    openExternal: vi.fn(async (_url: string) => {}),
    showItemInFolder: vi.fn((_path: string) => {}),
    showMessageBox: vi.fn(async (..._args: any[]) => ({ response: 0 })),
}));

vi.mock("electron", () => ({
    shell: { openExternal: Mocks.openExternal, showItemInFolder: Mocks.showItemInFolder },
    dialog: { showMessageBox: Mocks.showMessageBox },
    BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
}));
vi.mock("./emain-platform", () => ({
    callWithOriginalXdgCurrentDesktopAsync: async (fn: () => Promise<void>) => fn(),
}));
vi.mock("./moltenterm-i18n", () => ({ mt: (key: string, vars?: any) => `${key} ${JSON.stringify(vars ?? {})}` }));

import {
    allowPageExternalLaunch,
    ExternalConfirm,
    ExternalDrop,
    externalLinkAction,
    ExternalOpen,
    ExternalShowInFolder,
    openExternalLink,
    openLinkInApp,
    OpenLinkChannel,
} from "./moltenterm-external-links";

beforeEach(() => {
    Mocks.openExternal.mockClear();
    Mocks.showItemInFolder.mockClear();
    Mocks.showMessageBox.mockReset();
    Mocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe("external link rule (#663)", () => {
    it("opens web pages and mail at once", () => {
        expect(externalLinkAction("https://github.com/a/b/pull/1").action).toBe(ExternalOpen);
        expect(externalLinkAction("http://localhost:3000/").action).toBe(ExternalOpen);
        expect(externalLinkAction("mailto:someone@example.com").action).toBe(ExternalOpen);
        expect(externalLinkAction("HTTPS://EXAMPLE.COM").action).toBe(ExternalOpen);
    });

    it("shows a local file in its folder, and drops a file on another host", () => {
        expect(externalLinkAction("file:///Users/me/.ssh/id_rsa")).toEqual({
            action: ExternalShowInFolder,
            path: "/Users/me/.ssh/id_rsa",
        });
        expect(externalLinkAction("file://server/share/x.app").action).toBe(ExternalDrop);
    });

    it("drops page-only schemes and anything unparsable", () => {
        for (const url of [
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "blob:https://example.com/1",
            "about:blank",
            "vbscript:x",
            "",
            "   ",
            "not a url",
            null,
            42,
            "https://",
        ]) {
            expect(externalLinkAction(url).action).toBe(ExternalDrop);
        }
    });

    it("asks for any other scheme, naming it", () => {
        expect(externalLinkAction("zoommtg://zoom.us/join?confno=1")).toMatchObject({
            action: ExternalConfirm,
            scheme: "zoommtg",
        });
        expect(externalLinkAction("vscode://file/x").action).toBe(ExternalConfirm);
        expect(externalLinkAction("smb://server/share").action).toBe(ExternalConfirm);
    });

    it("never hands a file or an unknown scheme straight to the system", async () => {
        expect(await openExternalLink("file:///Applications/Calculator.app")).toBe(true);
        expect(Mocks.showItemInFolder).toHaveBeenCalledWith("/Applications/Calculator.app");
        expect(await openExternalLink("javascript:alert(1)")).toBe(false);
        expect(await openExternalLink("data:text/html,x")).toBe(false);
        expect(await openExternalLink("customapp://do-something")).toBe(false);
        expect(Mocks.showMessageBox).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(Mocks.showMessageBox.mock.calls[0])).toContain("customapp://do-something");
        expect(Mocks.openExternal).not.toHaveBeenCalled();
    });

    it("opens an unknown scheme once the user confirms, and web pages without asking", async () => {
        Mocks.showMessageBox.mockResolvedValue({ response: 1 });
        expect(await openExternalLink("customapp://do-something")).toBe(true);
        expect(Mocks.openExternal).toHaveBeenCalledWith("customapp://do-something");
        Mocks.showMessageBox.mockClear();
        expect(await openExternalLink("https://example.com/")).toBe(true);
        expect(Mocks.showMessageBox).not.toHaveBeenCalled();
        expect(Mocks.openExternal).toHaveBeenLastCalledWith("https://example.com/");
    });

    it("lets a page launch mail, asks for an app scheme and refuses files", async () => {
        expect(await allowPageExternalLaunch("mailto:a@b.c", null)).toBe(true);
        expect(await allowPageExternalLaunch("file:///etc/passwd", null)).toBe(false);
        expect(await allowPageExternalLaunch("zoommtg://x", null)).toBe(false);
        Mocks.showMessageBox.mockResolvedValue({ response: 1 });
        expect(await allowPageExternalLaunch("zoommtg://x", null)).toBe(true);
    });
});

describe("web pages the app opens by itself (#2176)", () => {
    function host(destroyed = false) {
        return { isDestroyed: () => destroyed, send: vi.fn(), hostWebContents: null } as any;
    }

    it("sends a web page to the tab's renderer, never to the system", async () => {
        const tab = host();
        expect(await openLinkInApp("https://example.com/docs", tab)).toBe(true);
        expect(await openLinkInApp("http://localhost:8123/callback?code=x", tab)).toBe(true);
        expect(tab.send).toHaveBeenNthCalledWith(1, OpenLinkChannel, "https://example.com/docs");
        expect(tab.send).toHaveBeenNthCalledWith(2, OpenLinkChannel, "http://localhost:8123/callback?code=x");
        expect(Mocks.openExternal).not.toHaveBeenCalled();
    });

    it("keeps the shared rule for anything else", async () => {
        const tab = host();
        expect(await openLinkInApp("mailto:someone@example.com", tab)).toBe(true);
        expect(Mocks.openExternal).toHaveBeenCalledWith("mailto:someone@example.com");
        expect(await openLinkInApp("file:///tmp/x.app", tab)).toBe(true);
        expect(Mocks.showItemInFolder).toHaveBeenCalledWith("/tmp/x.app");
        expect(await openLinkInApp("javascript:alert(1)", tab)).toBe(false);
        expect(tab.send).not.toHaveBeenCalled();
    });

    it("falls back to the system when no tab can take the page, so a link is never lost", async () => {
        expect(await openLinkInApp("https://example.com/", null)).toBe(true);
        expect(await openLinkInApp("https://example.com/2", host(true))).toBe(true);
        expect(Mocks.openExternal).toHaveBeenNthCalledWith(1, "https://example.com/");
        expect(Mocks.openExternal).toHaveBeenNthCalledWith(2, "https://example.com/2");
    });
});
