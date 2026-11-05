// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { hardenWebviewAttach, refusedWebviewSrc, webviewPreloadFile } from "./moltenterm-webview-attach-policy";

const PagePreload = webviewPreloadFile("/app");

describe("webview attach policy (#1961)", () => {
    it("forces no Node, isolation, sandbox and web security whatever the tag asked", () => {
        const preferences: Record<string, unknown> = {
            nodeIntegration: true,
            nodeIntegrationInSubFrames: true,
            nodeIntegrationInWorker: true,
            contextIsolation: false,
            sandbox: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
            experimentalFeatures: true,
            webviewTag: true,
            enableBlinkFeatures: "Something",
        };
        expect(hardenWebviewAttach(preferences, { src: "https://example.test/" }, PagePreload)).toBe(true);
        expect(preferences).toEqual({
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            webviewTag: false,
        });
    });

    it("keeps MoltenTerm's page preload, as a path or a file URL, and strips any other", () => {
        for (const own of [PagePreload, "file://" + PagePreload, "/app/preload/../preload/preload-webview.cjs"]) {
            const preferences: Record<string, unknown> = { preload: own };
            hardenWebviewAttach(preferences, {}, PagePreload);
            expect(preferences.preload).toBe(own);
        }
        for (const other of [
            "/tmp/evil.cjs",
            "file:///Users/me/Downloads/preload.js",
            "/app/preload/index.cjs",
            "https://example.test/preload.js",
            "",
        ]) {
            const preferences: Record<string, unknown> = { preload: other, preloadURL: "file:///tmp/x.js" };
            hardenWebviewAttach(preferences, {}, PagePreload);
            expect(preferences.preload).toBeUndefined();
            expect(preferences.preloadURL).toBeUndefined();
        }
    });

    it("refuses script and engine URLs as a guest's first page, and keeps the rest", () => {
        for (const src of [
            "javascript:alert(1)",
            " JavaScript:alert(1)",
            "vbscript:x",
            "chrome://settings",
            "devtools://devtools/bundled/inspector.html",
            "chrome-devtools://x",
            "view-source:https://example.test",
        ]) {
            expect(refusedWebviewSrc(src)).toBe(true);
            expect(hardenWebviewAttach({}, { src }, PagePreload)).toBe(false);
        }
        for (const src of [
            "https://example.test",
            "http://localhost:3000",
            "about:blank#moltenterm-start",
            "",
            undefined,
        ]) {
            expect(refusedWebviewSrc(src)).toBe(false);
        }
    });
});
