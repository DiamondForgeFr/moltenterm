// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    cdpMethodAllowed,
    isSyntheticInputMethod,
    isTakeoverKey,
    isTakeoverMouse,
    validRegistration,
    webviewKey,
} from "./moltenterm-browseragent-policy";

describe("DevTools allow-list (DS-BRW-012)", () => {
    it("allows the page, accessibility, DOM, input and emulation methods the tools use", () => {
        for (const method of [
            "Page.getNavigationHistory",
            "Page.captureScreenshot",
            "Accessibility.getFullAXTree",
            "DOM.getBoxModel",
            "Input.dispatchMouseEvent",
            "Emulation.setDeviceMetricsOverride",
        ]) {
            expect(cdpMethodAllowed(method)).toBe(true);
        }
    });

    it("never allows credentials, storage, targets, interception or raw passthrough", () => {
        for (const method of [
            "Network.getCookies",
            "Network.getAllCookies",
            "Network.setCookie",
            "Network.getResponseBody",
            "Storage.getCookies",
            "Storage.clearDataForOrigin",
            "IndexedDB.requestData",
            "DOMStorage.getDOMStorageItems",
            "CacheStorage.requestEntries",
            "Target.createTarget",
            "Target.attachToTarget",
            "Browser.close",
            "Fetch.enable",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "DOM.setFileInputFiles",
            "Page.navigate ",
            "page.navigate",
            "",
            null,
            undefined,
            42,
        ]) {
            expect(cdpMethodAllowed(method)).toBe(false);
        }
    });

    it("tells the agent's own input from the user's", () => {
        expect(isSyntheticInputMethod("Input.dispatchKeyEvent")).toBe(true);
        expect(isSyntheticInputMethod("Page.navigate")).toBe(false);
        expect(isTakeoverKey({ type: "keyDown" })).toBe(true);
        expect(isTakeoverKey({ type: "keyUp" })).toBe(false);
        expect(isTakeoverMouse({ type: "mouseDown" })).toBe(true);
        expect(isTakeoverMouse({ type: "mouseMove" })).toBe(false);
        expect(isTakeoverMouse({ type: "mouseWheel" })).toBe(false);
    });

    it("accepts only well-formed webview registrations", () => {
        expect(validRegistration("block", "tab", 12)).toBe(true);
        expect(validRegistration("", "tab", 12)).toBe(false);
        expect(validRegistration("block", "x".repeat(201), 12)).toBe(false);
        expect(validRegistration("block", "tab", 1.5)).toBe(false);
        expect(validRegistration("block", "tab", -1)).toBe(false);
        expect(validRegistration({}, "tab", 3)).toBe(false);
        expect(webviewKey("b", "t")).toBe("b/t");
    });
});
