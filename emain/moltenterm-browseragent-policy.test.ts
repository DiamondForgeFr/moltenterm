// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    captureParams,
    captureTargetSize,
    cdpMethodAllowed,
    downloadHost,
    expectedSignature,
    flattenBitmapOnWhite,
    InspectElementSource,
    InspectFocusedScript,
    inspectParams,
    inspectPointScript,
    isMoltenOperation,
    isSyntheticInputMethod,
    isTakeoverKey,
    isTakeoverMouse,
    nativeKeySignature,
    nativeMouseSignature,
    navigateParams,
    pageSignature,
    pageTextParams,
    pageTextScript,
    redirectLeavesHost,
    sanitizeEmulationParams,
    sanitizeInputParams,
    setFieldParams,
    SetFieldSource,
    slimAxTree,
    SyntheticInputExpiryMs,
    SyntheticInputLedger,
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

describe("MoltenTerm operations (FR-BRW-009)", () => {
    it("are not DevTools methods and keep Runtime off the allow-list", () => {
        expect(isMoltenOperation("Molten.navigate")).toBe(true);
        expect(isMoltenOperation("Molten.pageText")).toBe(true);
        expect(isMoltenOperation("Molten.capture")).toBe(true);
        expect(isMoltenOperation("Molten.evaluate")).toBe(false);
        expect(isMoltenOperation("Runtime.evaluate")).toBe(false);
        expect(cdpMethodAllowed("Molten.navigate")).toBe(false);
        expect(cdpMethodAllowed("Runtime.evaluate")).toBe(false);
    });

    it("navigate loads http and https pages only", () => {
        expect(navigateParams({ url: "https://example.com/a?b=1", timeoutms: 5000 })).toEqual({
            url: "https://example.com/a?b=1",
            timeoutMs: 5000,
        });
        expect(navigateParams({ url: "http://localhost:3000" })?.timeoutMs).toBe(30000);
        expect(navigateParams({ history: { index: 2, expect: "https://x.example/a" } })).toEqual({
            history: { index: 2, expect: "https://x.example/a" },
            timeoutMs: 30000,
        });
        expect(navigateParams({ history: { index: 0, expect: "about:blank" } })?.history.index).toBe(0);
        expect(navigateParams({ history: { index: -1, expect: "https://x.example" } })).toBe(null);
        expect(navigateParams({ history: { index: 1.5, expect: "https://x.example" } })).toBe(null);
        expect(navigateParams({ history: { index: 1, expect: "file:///etc/passwd" } })).toBe(null);
        expect(navigateParams({ history: { index: 1, expect: "https://x.example" }, url: "https://x.example" })).toBe(
            null
        );
        expect(navigateParams({ url: "https://x.example", timeoutms: 999999 })?.timeoutMs).toBe(30000);
        for (const url of [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "about:blank",
            "chrome://settings",
            "devtools://devtools",
            "https://user:pw@example.com",
            "not a url",
            "https://" + "a".repeat(9000) + ".com",
            42,
        ]) {
            expect(navigateParams({ url })).toBe(null);
        }
    });

    it("sends only what the reading tools use of the accessibility tree", () => {
        const slim = slimAxTree({
            nodes: [
                {
                    nodeId: "1",
                    ignored: false,
                    ignoredReasons: [{ name: "x" }],
                    role: { type: "role", value: "button" },
                    name: { type: "computedString", value: "Go", sources: [{ type: "contents" }] },
                    properties: [
                        { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
                        { name: "disabled", value: { type: "boolean", value: true } },
                    ],
                    childIds: ["2"],
                    backendDOMNodeId: 7,
                    frameId: "F",
                },
            ],
        });
        expect(slim).toEqual({
            nodes: [
                {
                    nodeId: "1",
                    ignored: false,
                    role: { value: "button" },
                    name: { value: "Go" },
                    properties: [{ name: "disabled", value: { value: true } }],
                    childIds: ["2"],
                    backendDOMNodeId: 7,
                },
            ],
        });
        expect(slimAxTree(null)).toEqual({ nodes: [] });
    });

    it("stops a redirect that leaves the host", () => {
        expect(redirectLeavesHost("https://a.example/x", "https://a.example/y")).toBe(false);
        expect(redirectLeavesHost("https://a.example/x", "https://b.example/y")).toBe(true);
        expect(redirectLeavesHost("http://127.0.0.1:3000/", "http://127.0.0.1:4000/")).toBe(true);
        expect(redirectLeavesHost("https://a.example/", "not a url")).toBe(true);
    });

    it("page text takes a bounded size and its script is fixed", () => {
        expect(pageTextParams({ maxchars: 50000 })).toEqual({ maxChars: 50000 });
        expect(pageTextParams({ maxchars: 1e12 })).toEqual({ maxChars: 2000000 });
        expect(pageTextParams({ maxchars: "50000" })).toBe(null);
        expect(pageTextParams({ maxchars: 0 })).toBe(null);
        const script = pageTextScript(123.9);
        expect(script).toContain("slice(0, 123)");
        expect(script).toContain("innerText");
        expect(script).not.toContain("value");
    });

    it("capture checks its region, size and format", () => {
        expect(captureParams({ format: "gif" })).toBe(null);
        expect(captureParams({ format: "jpeg" })).toEqual({
            maxSide: 1568,
            scale: 1,
            format: "jpeg",
            quality: 80,
            maxBytes: 1 << 20,
        });
        expect(captureParams({ format: "png", clip: { x: 10, y: 20, width: 100, height: 50 } })?.clip).toEqual({
            x: 10,
            y: 20,
            width: 100,
            height: 50,
        });
        expect(captureParams({ format: "png", clip: { x: -1, y: 0, width: 10, height: 10 } })).toBe(null);
        expect(captureParams({ format: "png", clip: { x: 0, y: 0, width: 0, height: 10 } })).toBe(null);
        expect(captureParams({ format: "png", clip: { x: 0, y: 0, width: NaN, height: 10 } })).toBe(null);
        expect(captureParams({ format: "jpeg", scale: 5, quality: 1000, maxside: 1e9 })).toMatchObject({
            scale: 1,
            quality: 100,
            maxSide: 4096,
        });
    });

    it("draws a transparent page over white", () => {
        const bitmap = new Uint8Array([0, 0, 0, 0, 10, 20, 30, 255, 50, 50, 50, 128]);
        flattenBitmapOnWhite(bitmap);
        expect([...bitmap]).toEqual([255, 255, 255, 255, 10, 20, 30, 255, 177, 177, 177, 255]);
    });

    it("scales a capture to the long side, never up", () => {
        expect(captureTargetSize(2560, 1600, 1568, 1)).toEqual({ width: 1568, height: 980 });
        expect(captureTargetSize(800, 600, 1568, 1)).toEqual({ width: 800, height: 600 });
        expect(captureTargetSize(800, 600, 1568, 0.5)).toEqual({ width: 400, height: 300 });
        expect(captureTargetSize(0, 0, 1568, 1)).toEqual({ width: 0, height: 0 });
    });
});

describe("input sanitising (FR-BRW-010)", () => {
    it("rebuilds mouse events from known fields and refuses anything else", () => {
        expect(
            sanitizeInputParams("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x: 10,
                y: 20,
                button: "left",
                buttons: 1,
                clickCount: 2,
                modifiers: 8,
                pointerType: "pen",
            })
        ).toEqual({ type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 8 });
        expect(
            sanitizeInputParams("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaY: 300 })
        ).toMatchObject({ deltaX: 0, deltaY: 300 });
        for (const bad of [
            { type: "mouseDragStart", x: 1, y: 1 },
            { type: "mousePressed", x: Number.NaN, y: 1 },
            { type: "mousePressed", x: 1, y: 1, button: "back" },
            { type: "mousePressed", x: 1, y: 1, clickCount: 9 },
            { type: "mousePressed", x: 1, y: 1, modifiers: 99 },
            { type: "mouseWheel", x: 1, y: 1, deltaY: 1e9 },
        ]) {
            expect(sanitizeInputParams("Input.dispatchMouseEvent", bad)).toBeNull();
        }
    });

    it("keeps editing commands to selection and undo, never the clipboard", () => {
        const out = sanitizeInputParams("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: 4,
            commands: ["selectAll", "paste", "copy", "cut", "undo"],
        });
        expect(out.commands).toEqual(["selectAll", "undo"]);
        expect(
            sanitizeInputParams("Input.dispatchKeyEvent", { type: "keyDown", key: "v", commands: ["paste"] }).commands
        ).toBeUndefined();
        expect(sanitizeInputParams("Input.dispatchKeyEvent", { type: "keyDown", key: "x".repeat(40) })).toBeNull();
        expect(
            sanitizeInputParams("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "far too long" })
        ).toBeNull();
        expect(sanitizeInputParams("Input.insertText", { text: "hello" })).toEqual({ text: "hello" });
        expect(sanitizeInputParams("Input.insertText", { text: "x".repeat(10001) })).toBeNull();
        expect(sanitizeInputParams("Input.dispatchTouchEvent", { type: "touchStart" })).toBeNull();
    });

    it("bounds the emulated viewport and never emulates a mobile device", () => {
        expect(sanitizeEmulationParams({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true })).toEqual({
            width: 390,
            height: 844,
            deviceScaleFactor: 0,
            mobile: false,
        });
        expect(sanitizeEmulationParams({ width: 50, height: 844 })).toBeNull();
        expect(sanitizeEmulationParams({ width: 390.5, height: 844 })).toBeNull();
        expect(sanitizeEmulationParams({ width: 5000, height: 844 })).toBeNull();
    });
});

describe("takeover by sequence (FR-BRW-008 AC7, FR-BRW-010)", () => {
    const mouse = (x: number, y: number, button = "left") => ({ kind: "mouse" as const, button, x, y });
    const key = (k: string, code = "") => ({ kind: "key" as const, key: k, code });

    it("claims each dispatched input once per observer, oldest first", () => {
        const ledger = new SyntheticInputLedger();
        const a = ledger.expect(1, mouse(10, 10), 0);
        const b = ledger.expect(1, mouse(10, 10), 1);
        expect(b).toBeGreaterThan(a);
        expect(ledger.claim(1, "native", mouse(10, 10), 5)).toBe(true);
        expect(ledger.claim(1, "native", mouse(10, 10), 5)).toBe(true);
        expect(ledger.claim(1, "native", mouse(10, 10), 5)).toBe(false);
        expect(ledger.claim(1, "page", mouse(11, 9), 6)).toBe(true);
        expect(ledger.pending(1, 7)).toBe(1);
        expect(ledger.claim(1, "page", mouse(10, 10), 7)).toBe(true);
        expect(ledger.pending(1, 8)).toBe(0);
    });

    it("never takes input that does not match: another point, button, key, tab or kind", () => {
        const ledger = new SyntheticInputLedger();
        ledger.expect(1, mouse(10, 10), 0);
        ledger.expect(1, key("a", "KeyA"), 0);
        expect(ledger.claim(1, "native", mouse(40, 10), 1)).toBe(false);
        expect(ledger.claim(1, "native", mouse(10, 10, "right"), 1)).toBe(false);
        expect(ledger.claim(2, "native", mouse(10, 10), 1)).toBe(false);
        expect(ledger.claim(1, "native", key("b", "KeyB"), 1)).toBe(false);
        expect(ledger.claim(1, "native", key("a", "KeyQ"), 1)).toBe(false);
        expect(ledger.claim(1, "native", key("a", ""), 1)).toBe(true);
    });

    it("matches native points scaled by the page zoom", () => {
        const ledger = new SyntheticInputLedger();
        ledger.expect(1, mouse(100, 50), 0);
        expect(ledger.claim(1, "native", mouse(150, 75), 1, 1.5)).toBe(true);
    });

    it("forgets entries after the expiry, and a forgotten tab", () => {
        const ledger = new SyntheticInputLedger();
        ledger.expect(1, mouse(10, 10), 0);
        expect(ledger.claim(1, "native", mouse(10, 10), SyntheticInputExpiryMs)).toBe(false);
        ledger.expect(1, mouse(10, 10), 0);
        ledger.forget(1);
        expect(ledger.claim(1, "native", mouse(10, 10), 1)).toBe(false);
    });

    it("expects presses and key downs only", () => {
        expect(
            expectedSignature("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 1, y: 2 })
        ).toEqual(mouse(1, 2));
        expect(expectedSignature("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 })).toBeNull();
        expect(expectedSignature("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "w", code: "KeyW" })).toEqual(
            key("w", "KeyW")
        );
        expect(expectedSignature("Input.dispatchKeyEvent", { type: "keyUp", key: "w" })).toBeNull();
        expect(expectedSignature("Input.insertText", { text: "x" })).toBeNull();
    });

    it("reads the observers' events, and a report it cannot read is nobody's", () => {
        expect(nativeMouseSignature({ type: "mouseDown", button: "left", x: 3, y: 4 })).toEqual(mouse(3, 4));
        expect(nativeKeySignature({ type: "keyDown", key: "Enter", code: "Enter" })).toEqual(key("Enter", "Enter"));
        expect(pageSignature({ type: "mousedown", button: 2, x: 3, y: 4 })).toEqual(mouse(3, 4, "right"));
        expect(pageSignature({ type: "keydown", key: "a", code: "KeyA" })).toEqual(key("a", "KeyA"));
        expect(pageSignature({ type: "mousedown" })).toBeNull();
        expect(pageSignature(null)).toBeNull();
    });
});

describe("Molten.inspect and Molten.setField (FR-BRW-010)", () => {
    it("are MoltenTerm operations, with bounded parameters", () => {
        expect(isMoltenOperation("Molten.inspect")).toBe(true);
        expect(isMoltenOperation("Molten.setField")).toBe(true);
        expect(inspectParams({ focused: true })).toEqual({ focused: true });
        expect(inspectParams({ backendnodeid: 12 })).toEqual({ backendNodeId: 12 });
        expect(inspectParams({ x: 10, y: 20 })).toEqual({ point: { x: 10, y: 20 } });
        expect(inspectParams({ x: -1, y: 20 })).toBeNull();
        expect(inspectParams({ code: "alert(1)" })).toBeNull();
        expect(setFieldParams({ backendnodeid: 3, value: true })).toEqual({ backendNodeId: 3, value: true });
        expect(setFieldParams({ backendnodeid: 3, value: { x: 1 } })).toBeNull();
        expect(setFieldParams({ backendnodeid: 0, value: "a" })).toBeNull();
        expect(setFieldParams({ backendnodeid: 3, value: "x".repeat(10001) })).toBeNull();
    });

    it("run fixed functions that parse and never read a field's value for the label", () => {
        expect(() => new Function(`return (${InspectElementSource});`)).not.toThrow();
        expect(() => new Function(`return ${InspectFocusedScript};`)).not.toThrow();
        expect(() => new Function(`return ${inspectPointScript(1, 2)};`)).not.toThrow();
        expect(() => new Function(`return (${SetFieldSource});`)).not.toThrow();
        expect(inspectPointScript(Number.NaN, 2)).toContain("elementFromPoint(NaN, 2)");
        expect(InspectElementSource).not.toMatch(/control\.value|target\.value|\.value\b(?!\s*=)/);
    });

    it("names a download's host only", () => {
        expect(downloadHost("https://Files.Example.com:8443/a.zip?token=SECRET")).toBe("files.example.com:8443");
        expect(downloadHost("blob:https://app.example.com/1234-5678")).toBe("app.example.com");
        expect(downloadHost("data:text/plain,hi")).toBe("");
    });
});
