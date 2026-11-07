// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from "events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configurePrivilegedIpc } from "./moltenterm-privileged-ipc";

const Mocks = vi.hoisted(() => ({
    appListeners: new Map<string, (...args: any[]) => void>(),
    ipcListeners: new Map<string, (...args: any[]) => void>(),
    contents: new Map<number, any>(),
    setConfig: vi.fn(async (_client: any, _data: any) => {}),
    popupGuests: new Map<number, any>(),
}));

vi.mock("electron", () => ({
    session: {
        defaultSession: {
            setPermissionRequestHandler() {},
            setPermissionCheckHandler() {},
            setDevicePermissionHandler() {},
        },
    },
    app: { on: (event: string, fn: any) => Mocks.appListeners.set(event, fn) },
    ipcMain: { on: (channel: string, fn: any) => Mocks.ipcListeners.set(channel, fn) },
    webContents: { fromId: (id: number) => Mocks.contents.get(id) ?? null },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => {} }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: Mocks.setConfig } }));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./moltenterm-external-links", () => ({ allowPageExternalLaunch: async () => false }));
vi.mock("./moltenterm-popups", () => ({
    isPanelPopup: (id: number) => Mocks.popupGuests.has(id),
    popupGuestOf: (id: number) => Mocks.popupGuests.get(id) ?? null,
}));

import {
    ClientCertificateAnswerChannel,
    ClientCertificateAskChannel,
    ClientCertificateDoneChannel,
    initMoltentermClientCertificates,
    installMoltentermClientCertificateHandler,
} from "./moltenterm-client-certificates";

let nextId = 1;
function contents(type: string, url: string, host?: any): any {
    const wc: any = new EventEmitter();
    wc.id = nextId++;
    wc.getType = () => type;
    wc.getURL = () => url;
    wc.mainFrame = { url };
    wc.isDestroyed = () => false;
    wc.hostWebContents = host;
    wc.sent = [] as any[][];
    wc.send = (...args: any[]) => wc.sent.push(args);
    Mocks.contents.set(wc.id, wc);
    return wc;
}

const Alice = {
    fingerprint: "sha256/alice",
    subject: { commonName: "Alice" },
    issuer: { commonName: "Acme CA" },
    validExpiry: 1_900_000_000,
    data: "PEM-OF-ALICE",
};
const Work = { fingerprint: "sha256/work", subjectName: "CN=work", issuerName: "CN=Root", data: "PEM-OF-WORK" };

type Outcome = { event: any; picked: Promise<any[]> };

// What Electron does: an event to prevent, and a callback that settles the request.
function selectCertificate(wc: any, requested: string, list: any[]): Outcome {
    const event = { preventDefault: vi.fn() };
    const picked = new Promise<any[]>((resolve) => {
        Mocks.appListeners.get("select-client-certificate")(event, wc, requested, list, (...args: any[]) =>
            resolve(args)
        );
    });
    return { event, picked };
}

function asks(host: any): any[][] {
    return host.sent.filter((s: any[]) => s[0] === ClientCertificateAskChannel);
}

function answer(sender: any, requestId: string, decision: string, fingerprint?: string): void {
    Mocks.ipcListeners.get(ClientCertificateAnswerChannel)(
        { sender, senderFrame: sender.mainFrame },
        requestId,
        decision,
        fingerprint
    );
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

function tab(): { host: any; guest: any } {
    const host = contents("browserView", "file:///app/index.html");
    return { host, guest: contents("webview", "https://corp.example.com/", host) };
}

beforeAll(() => {
    configurePrivilegedIpc(
        (event) =>
            Mocks.contents.get(event.sender.id) === event.sender &&
            event.sender.getType() === "browserView" &&
            event.senderFrame === event.sender.mainFrame &&
            event.senderFrame.url === "file:///app/index.html"
    );
    installMoltentermClientCertificateHandler();
});

beforeEach(() => {
    Mocks.setConfig.mockClear();
    Mocks.popupGuests.clear();
    initMoltentermClientCertificates({ settings: {} } as any);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("client certificates (#1979)", () => {
    it("takes the choice from Electron at once, and presents nothing until the user picked", async () => {
        const { host, guest } = tab();
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice, Work]);
        // The default is the first certificate of the store: prevented in the same tick.
        expect(outcome.event.preventDefault).toHaveBeenCalledTimes(1);
        await waitFor(() => asks(host).length === 1);
        const [, requestId, guestId, site, certificates] = asks(host)[0];
        expect([guestId, site]).toEqual([guest.id, "corp.example.com"]);
        expect(certificates.map((c: any) => c.fingerprint)).toEqual(["sha256/alice", "sha256/work"]);
        expect(JSON.stringify(certificates)).not.toContain("PEM-OF");
        answer(host, requestId, "use", "sha256/work");
        const [certificate] = await outcome.picked;
        expect(certificate).toBe(Work);
    });

    it("remembers the pick for the site, and uses it without asking again", async () => {
        const { host, guest } = tab();
        const first = selectCertificate(guest, "corp.example.com:443", [Alice, Work]);
        await waitFor(() => asks(host).length === 1);
        answer(host, asks(host)[0][1], "use", "sha256/alice");
        expect((await first.picked)[0]).toBe(Alice);
        expect(Mocks.setConfig.mock.calls[0][1]).toEqual({
            "browser:clientcertificates": { "corp.example.com": "sha256/alice" },
        });
        host.sent.length = 0;
        const again = selectCertificate(guest, "corp.example.com:443", [Work, Alice]);
        expect((await again.picked)[0]).toBe(Alice);
        expect(asks(host)).toEqual([]);
    });

    it("asks again for a site whose remembered certificate is gone, and never falls back to another", async () => {
        const { host, guest } = tab();
        initMoltentermClientCertificates({
            settings: { "browser:clientcertificates": { "corp.example.com": "sha256/removed" } },
        } as any);
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice, Work]);
        await waitFor(() => asks(host).length === 1);
        answer(host, asks(host)[0][1], "dismiss");
        expect(await outcome.picked).toEqual([]);
    });

    it("goes without a certificate when the user says so, and remembers that", async () => {
        const { host, guest } = tab();
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 1);
        answer(host, asks(host)[0][1], "none");
        expect(await outcome.picked).toEqual([]);
        expect(Mocks.setConfig.mock.calls[0][1]).toEqual({
            "browser:clientcertificates": { "corp.example.com": "none" },
        });
        host.sent.length = 0;
        expect(await selectCertificate(guest, "corp.example.com:443", [Alice]).picked).toEqual([]);
        expect(asks(host)).toEqual([]);
    });

    it("sends no certificate and remembers nothing on Escape", async () => {
        const { host, guest } = tab();
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 1);
        answer(host, asks(host)[0][1], "dismiss");
        expect(await outcome.picked).toEqual([]);
        expect(Mocks.setConfig).not.toHaveBeenCalled();
    });

    it("accepts the answer from the tab's window only, and only a certificate that was offered", async () => {
        const { host, guest } = tab();
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 1);
        const requestId = asks(host)[0][1];
        answer(contents("browserView", "file:///app/index.html"), requestId, "use", "sha256/alice");
        answer(guest, requestId, "use", "sha256/alice");
        answer(contents("browserView", "https://evil.example/"), requestId, "use", "sha256/alice");
        answer(host, requestId, "use", "sha256/not-offered");
        expect(await outcome.picked).toEqual([]);
        expect(Mocks.setConfig).not.toHaveBeenCalled();
    });

    it("gives MoltenTerm's own renderers and requests from no page no certificate", async () => {
        const app = contents("browserView", "file:///app/index.html");
        const outcome = selectCertificate(app, "localhost:1234", [Alice]);
        expect(outcome.event.preventDefault).toHaveBeenCalled();
        expect(await outcome.picked).toEqual([]);
        expect(await selectCertificate(null, "corp.example.com:443", [Alice]).picked).toEqual([]);
        expect(app.sent).toEqual([]);
    });

    it("never asks for a page nothing shows a question for", async () => {
        const orphan = contents("webview", "https://corp.example.com/");
        expect(await selectCertificate(orphan, "corp.example.com:443", [Alice]).picked).toEqual([]);
        const notWeb = contents("webview", "file:///x.html", contents("browserView", "file:///app/index.html"));
        expect(await selectCertificate(notWeb, "file:///x.html", [Alice]).picked).toEqual([]);
    });

    it("uses a remembered choice for a page no panel shows, and asks nothing", async () => {
        initMoltentermClientCertificates({
            settings: { "browser:clientcertificates": { "corp.example.com": "sha256/work" } },
        } as any);
        const { host, guest } = tab();
        expect((await selectCertificate(guest, "corp.example.com:443", [Alice, Work]).picked)[0]).toBe(Work);
        expect(asks(host)).toEqual([]);
    });

    it("asks a popup's question in its opener's tab", async () => {
        const { host, guest } = tab();
        const popup = contents("window", "https://corp.example.com/popup");
        Mocks.popupGuests.set(popup.id, guest);
        const outcome = selectCertificate(popup, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 1);
        expect(asks(host)[0][2]).toBe(guest.id);
        answer(host, asks(host)[0][1], "use", "sha256/alice");
        expect((await outcome.picked)[0]).toBe(Alice);
    });

    it("asks one question for requests of the same site at once", async () => {
        const { host, guest } = tab();
        const first = selectCertificate(guest, "corp.example.com:443", [Alice, Work]);
        const second = selectCertificate(guest, "corp.example.com:443", [Work, Alice]);
        await waitFor(() => asks(host).length >= 1);
        expect(asks(host)).toHaveLength(1);
        answer(host, asks(host)[0][1], "use", "sha256/work");
        expect((await first.picked)[0]).toBe(Work);
        expect((await second.picked)[0]).toBe(Work);
    });

    it("withdraws the question when the page moves on or closes", async () => {
        const { host, guest } = tab();
        const moved = selectCertificate(guest, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 1);
        guest.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
        guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
        expect(host.sent.filter((s: any[]) => s[0] === ClientCertificateDoneChannel)).toHaveLength(0);
        guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        expect(await moved.picked).toEqual([]);
        expect(host.sent.filter((s: any[]) => s[0] === ClientCertificateDoneChannel)).toEqual([
            [ClientCertificateDoneChannel, asks(host)[0][1]],
        ]);
        const closed = selectCertificate(guest, "corp.example.com:443", [Alice]);
        await waitFor(() => asks(host).length === 2);
        guest.emit("destroyed");
        expect(await closed.picked).toEqual([]);
        expect(Mocks.setConfig).not.toHaveBeenCalled();
    });

    it("goes without a certificate when nobody answers", async () => {
        vi.useFakeTimers();
        const { host, guest } = tab();
        const outcome = selectCertificate(guest, "corp.example.com:443", [Alice]);
        expect(asks(host)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
        expect(await outcome.picked).toEqual([]);
        expect(Mocks.setConfig).not.toHaveBeenCalled();
    });

    it("has nothing to ask when the system offers no certificate", async () => {
        const { host, guest } = tab();
        expect(await selectCertificate(guest, "corp.example.com:443", []).picked).toEqual([]);
        expect(asks(host)).toEqual([]);
    });
});
