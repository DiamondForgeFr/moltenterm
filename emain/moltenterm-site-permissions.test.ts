// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => {
    const sessions: any[] = [];
    const makeSession = () => {
        const s: any = {
            setPermissionRequestHandler: (fn: any) => (s.request = fn),
            setPermissionCheckHandler: (fn: any) => (s.check = fn),
            setDevicePermissionHandler: (fn: any) => (s.device = fn),
        };
        sessions.push(s);
        return s;
    };
    return {
        sessions,
        makeSession,
        defaultSession: makeSession(),
        appListeners: new Map<string, (...args: any[]) => void>(),
        ipcListeners: new Map<string, (...args: any[]) => void>(),
        contents: new Map<number, any>(),
        setConfig: vi.fn(async (_client: any, _data: any) => {}),
        popupGuests: new Map<number, any>(),
        externalLaunch: vi.fn(async (_url: string) => false),
    };
});

vi.mock("electron", () => ({
    session: { defaultSession: Mocks.defaultSession },
    app: { on: (event: string, fn: any) => Mocks.appListeners.set(event, fn) },
    ipcMain: { on: (channel: string, fn: any) => Mocks.ipcListeners.set(channel, fn) },
    webContents: { fromId: (id: number) => Mocks.contents.get(id) ?? null },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => {} }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: Mocks.setConfig } }));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./moltenterm-external-links", () => ({ allowPageExternalLaunch: Mocks.externalLaunch }));
vi.mock("./moltenterm-popups", () => ({
    isPanelPopup: (id: number) => Mocks.popupGuests.has(id),
    popupGuestOf: (id: number) => Mocks.popupGuests.get(id) ?? null,
}));

import {
    initMoltentermSitePermissions,
    installMoltentermSitePermissionHandlers,
    SitePermissionAnswerChannel,
    SitePermissionAskChannel,
} from "./moltenterm-site-permissions";

let nextId = 1;
function contents(type: string, url: string, host?: any): any {
    const wc: any = new EventEmitter();
    wc.id = nextId++;
    wc.getType = () => type;
    wc.getURL = () => url;
    wc.isDestroyed = () => false;
    wc.hostWebContents = host;
    wc.sent = [] as any[][];
    wc.send = (...args: any[]) => wc.sent.push(args);
    Mocks.contents.set(wc.id, wc);
    return wc;
}

function request(wc: any, permission: string, details: any = {}): Promise<boolean> {
    return new Promise((resolve) => Mocks.defaultSession.request(wc, permission, resolve, details));
}

function answer(sender: any, requestId: string, decision: string): void {
    Mocks.ipcListeners.get(SitePermissionAnswerChannel)({ sender }, requestId, decision);
}

function lastAsk(host: any): any[] {
    const asks = host.sent.filter((s: any[]) => s[0] === SitePermissionAskChannel);
    return asks[asks.length - 1];
}

async function waitFor(cond: () => boolean): Promise<void> {
    const deadline = Date.now() + 30000;
    while (!cond()) {
        if (Date.now() > deadline) {
            throw new Error("condition not met");
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

beforeAll(() => {
    installMoltentermSitePermissionHandlers();
});

beforeEach(() => {
    Mocks.setConfig.mockClear();
    initMoltentermSitePermissions({ settings: {} } as any);
});

describe("site permission handlers (#663)", () => {
    it("hooks the default session and every session created later, devices denied", () => {
        expect(Mocks.defaultSession.request).toBeTypeOf("function");
        expect(Mocks.defaultSession.check).toBeTypeOf("function");
        expect(Mocks.defaultSession.device()).toBe(false);
        const later = Mocks.makeSession();
        Mocks.appListeners.get("session-created")(later);
        expect(later.request).toBeTypeOf("function");
    });

    it("keeps Electron's default for MoltenTerm's own renderers", async () => {
        const app = contents("browserView", "file:///app/index.html");
        expect(await request(app, "clipboard-read")).toBe(true);
        expect(Mocks.defaultSession.check(app, "notifications", "file://", {})).toBe(true);
    });

    it("denies MIDI, HID, serial and clipboard reads to a page without asking", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://evil.example/", host);
        for (const permission of ["midi", "midiSysex", "hid", "serial", "usb", "clipboard-read", "display-capture"]) {
            expect(await request(guest, permission)).toBe(false);
        }
        expect(await request(guest, "fullscreen")).toBe(true);
        expect(host.sent).toEqual([]);
    });

    it("asks the panel tab for the camera, and remembers Allow for the site", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://meet.example.com/room", host);
        const granted = request(guest, "media", {
            mediaTypes: ["video", "audio"],
            requestingUrl: "https://meet.example.com/room",
        });
        await waitFor(() => lastAsk(host) != null);
        const [, requestId, guestId, site, kinds] = lastAsk(host);
        expect([guestId, site, kinds]).toEqual([guest.id, "meet.example.com", ["camera", "microphone"]]);
        // Another renderer cannot answer for the user.
        answer(contents("browserView", "file:///app/index.html"), requestId, "allow");
        answer(host, requestId, "allow");
        expect(await granted).toBe(true);
        expect(Mocks.setConfig.mock.calls[0][1]).toEqual({
            "browser:sitepermissions": { "meet.example.com": { camera: "allow", microphone: "allow" } },
        });
        host.sent.length = 0;
        expect(
            await request(guest, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.example.com/x" })
        ).toBe(true);
        expect(host.sent).toEqual([]);
        expect(Mocks.defaultSession.check(guest, "media", "https://meet.example.com", { mediaType: "video" })).toBe(
            true
        );
    });

    it("denies when the user blocks, and never asks that site again", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://maps.example.com/", host);
        const granted = request(guest, "geolocation", { requestingUrl: "https://maps.example.com/" });
        await waitFor(() => lastAsk(host) != null);
        answer(host, lastAsk(host)[1], "block");
        expect(await granted).toBe(false);
        host.sent.length = 0;
        expect(await request(guest, "geolocation", { requestingUrl: "https://maps.example.com/" })).toBe(false);
        expect(host.sent).toEqual([]);
        expect(Mocks.defaultSession.check(guest, "geolocation", "https://maps.example.com", {})).toBe(false);
    });

    it("refuses this time only on Escape or when no panel shows the question", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://news.example.com/", host);
        const granted = request(guest, "notifications", { requestingUrl: "https://news.example.com/" });
        await waitFor(() => lastAsk(host) != null);
        answer(host, lastAsk(host)[1], "dismiss");
        expect(await granted).toBe(false);
        expect(Mocks.setConfig).not.toHaveBeenCalled();
        host.sent.length = 0;
        const again = request(guest, "notifications", { requestingUrl: "https://news.example.com/" });
        await waitFor(() => lastAsk(host) != null);
        answer(host, lastAsk(host)[1], "dismiss");
        expect(await again).toBe(false);
    });

    it("asks a popup's question in its opener's tab, and refuses pages that are not web pages", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://login.example.com/", host);
        const popup = contents("window", "https://login.example.com/popup");
        Mocks.popupGuests.set(popup.id, guest);
        const granted = request(popup, "media", {
            mediaTypes: ["audio"],
            requestingUrl: "https://login.example.com/popup",
        });
        await waitFor(() => lastAsk(host) != null);
        expect(lastAsk(host)[2]).toBe(guest.id);
        answer(host, lastAsk(host)[1], "allow");
        expect(await granted).toBe(true);
        const local = contents("webview", "file:///Users/me/page.html", host);
        expect(
            await request(local, "media", { mediaTypes: ["video"], requestingUrl: "file:///Users/me/page.html" })
        ).toBe(false);
    });

    it("hands a page's app launch to the external link rule", async () => {
        const host = contents("browserView", "file:///app/index.html");
        const guest = contents("webview", "https://zoom.example.com/", host);
        Mocks.externalLaunch.mockResolvedValueOnce(true);
        expect(await request(guest, "openExternal", { externalURL: "zoommtg://x" })).toBe(true);
        expect(Mocks.externalLaunch).toHaveBeenCalledWith("zoommtg://x", guest);
        expect(await request(guest, "openExternal", { externalURL: "file:///x.app" })).toBe(false);
    });
});
