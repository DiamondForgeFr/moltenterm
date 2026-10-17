// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as appFetch } from "../frontend/util/fetchutil";
import {
    AuthKey,
    getAppDocumentUrl,
    getTrustedAppSession,
    nativeBackendHeaders,
    registerTrustedAppContents,
} from "./authkey";
import { AppSessionPartition, CallerHeader, CallerProofHeader } from "./moltenterm-app-auth-policy";

const env = vi.hoisted(() => ({
    contents: new Map<number, any>(),
    ipc: new Map<string, (event: any) => void>(),
    beforeHeaders: null as (details: any, callback: (result: any) => void) => void,
    install: vi.fn(),
    appSession: {} as any,
}));
vi.mock("electron", () => ({
    ipcMain: { on: (name: string, callback: any) => env.ipc.set(name, callback) },
    webContents: { fromId: (id: number) => env.contents.get(id) },
    session: { fromPartition: () => env.appSession },
    net: undefined,
}));
vi.mock("./emain-platform", () => ({ getElectronAppBasePath: () => "/app", isDevVite: false }));
vi.mock("../frontend/util/endpoints", () => ({
    getWebServerEndpoint: () => "http://127.0.0.1:12345",
    getWSServerEndpoint: () => "ws://127.0.0.1:12346",
}));

env.appSession.webRequest = {
    onBeforeSendHeaders: (_filter: any, callback: any) => {
        env.install();
        env.beforeHeaders = callback;
    },
};

function contents(id: number, app = true) {
    const value = Object.assign(new EventEmitter(), {
        id,
        session: app ? getTrustedAppSession() : {},
        mainFrame: { url: getAppDocumentUrl() },
        destroyed: false,
        getURL() {
            return this.mainFrame.url;
        },
        isDestroyed() {
            return this.destroyed;
        },
    });
    env.contents.set(id, value);
    if (app) registerTrustedAppContents(value as any);
    return value;
}

function request(wc: any, frame = wc.mainFrame, resourceType = "xhr", url = "http://127.0.0.1:12345/info") {
    let headers: any;
    env.beforeHeaders(
        {
            webContentsId: wc.id,
            frame,
            resourceType,
            url,
            requestHeaders: {
                "x-authkey": "copied",
                "X-Molten-Caller": "main",
                "x-molten-proof": "copied",
                Range: "bytes=0-3",
            },
        },
        (result) => {
            headers = result.requestHeaders;
        }
    );
    return headers;
}

afterEach(() => vi.unstubAllGlobals());

describe("Electron app caller integration", () => {
    it("installs one hook for the shared private session, before app requests", () => {
        const first = contents(1);
        const second = contents(2);
        expect(env.install).toHaveBeenCalledTimes(1);
        for (const wc of [first, second]) {
            const headers = request(wc);
            expect(headers["X-AuthKey"]).toBe(AuthKey);
            expect(headers[CallerHeader]).toBe("renderer");
            expect(headers[CallerProofHeader]).toMatch(/^[a-f0-9]{64}$/);
            expect(headers.Range).toBe("bytes=0-3");
        }
    });

    it("strips copied credentials from guests, popups, child frames, navigation and retired contents", () => {
        const app = contents(3);
        const guest = contents(4, false);
        expect(request(guest)).toEqual({ Range: "bytes=0-3" });
        expect(request(contents(5, false))).toEqual({ Range: "bytes=0-3" });
        expect(request(app, { url: getAppDocumentUrl() })).toEqual({ Range: "bytes=0-3" });
        for (const type of ["mainFrame", "subFrame"])
            expect(request(app, app.mainFrame, type)).toEqual({ Range: "bytes=0-3" });
        expect(request(app, app.mainFrame, "xhr", "https://example.test/info")).toEqual({ Range: "bytes=0-3" });
        app.mainFrame.url = "https://example.test";
        expect(request(app)).toEqual({ Range: "bytes=0-3" });
        app.mainFrame.url = getAppDocumentUrl();
        app.emit("destroyed");
        expect(request(app)).toEqual({ Range: "bytes=0-3" });
    });

    it("gates get-auth-key on the live registered main frame", () => {
        const app = contents(6);
        for (const [sender, senderFrame, expected] of [
            [app, app.mainFrame, AuthKey],
            [app, { url: getAppDocumentUrl() }, null],
            [contents(7, false), app.mainFrame, null],
        ]) {
            const event = { sender, senderFrame, returnValue: undefined };
            env.ipc.get("get-auth-key")(event);
            expect(event.returnValue).toBe(expected);
        }
    });

    it("keeps guest partitions separate without changing existing default/custom cookie partitions", () => {
        const app = contents(8);
        for (const partition of [AppSessionPartition, `persist:${AppSessionPartition}`]) {
            const event = { preventDefault: vi.fn() };
            app.emit("will-attach-webview", event, {}, { partition });
            expect(event.preventDefault).toHaveBeenCalledOnce();
        }
        for (const partition of [undefined, "persist:existing-site"]) {
            const event = { preventDefault: vi.fn() };
            const preferences: any = { session: env.appSession };
            app.emit("will-attach-webview", event, preferences, { partition });
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(preferences).toEqual({ partition: partition ?? "" });
        }
    });

    it("protects native global-fetch fallback and refuses redirect credential forwarding", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", fetch);
        await appFetch("http://127.0.0.1:12345/info", { redirect: "follow" });
        const init = fetch.mock.calls[0][1];
        expect(Object.fromEntries(init.headers)).toEqual(Object.fromEntries(new Headers(nativeBackendHeaders())));
        expect(init.redirect).toBe("error");
        for (const url of [
            "https://example.test",
            "http://127.0.0.1:12345.example.test",
            "http://user@127.0.0.1:12345/info",
        ]) {
            await appFetch(url, { headers: { ...nativeBackendHeaders(), Accept: "application/json" } });
            expect(Object.fromEntries(fetch.mock.calls.at(-1)[1].headers)).toEqual({ accept: "application/json" });
        }
    });
});
