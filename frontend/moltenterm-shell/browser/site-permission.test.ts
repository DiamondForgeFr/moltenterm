// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    checkPermission,
    classifyPermissionRequest,
    permissionSite,
    rememberedVerdict,
    siteDecisions,
    sitePermissionWhatKey,
    validDecision,
    withDecision,
    withoutDecision,
} from "./site-permission";

describe("site permissions of the browser panel (#663)", () => {
    it("allows fullscreen and clipboard writes, asks for media, location and notifications", () => {
        expect(classifyPermissionRequest("fullscreen")).toEqual({ verdict: "allow" });
        expect(classifyPermissionRequest("clipboard-sanitized-write")).toEqual({ verdict: "allow" });
        expect(classifyPermissionRequest("media", { mediaTypes: ["video", "audio"] })).toEqual({
            verdict: "ask",
            kinds: ["camera", "microphone"],
        });
        expect(classifyPermissionRequest("media", { mediaTypes: ["audio"] })).toEqual({
            verdict: "ask",
            kinds: ["microphone"],
        });
        expect(classifyPermissionRequest("geolocation")).toEqual({ verdict: "ask", kinds: ["location"] });
        expect(classifyPermissionRequest("notifications")).toEqual({ verdict: "ask", kinds: ["notifications"] });
        expect(classifyPermissionRequest("openExternal")).toEqual({ verdict: "external" });
    });

    it("denies devices, clipboard reads, screen capture and anything unknown", () => {
        for (const permission of [
            "midi",
            "midiSysex",
            "hid",
            "serial",
            "usb",
            "clipboard-read",
            "display-capture",
            "pointerLock",
            "keyboardLock",
            "idle-detection",
            "storage-access",
            "window-management",
            "mediaKeySystem",
            "fileSystem",
            "unknown",
            "",
        ]) {
            expect(classifyPermissionRequest(permission).verdict).toBe("deny");
        }
        expect(classifyPermissionRequest("media", { mediaTypes: [] }).verdict).toBe("deny");
        expect(classifyPermissionRequest("media", {}).verdict).toBe("deny");
    });

    it("remembers decisions per host and port, for web pages only", () => {
        expect(permissionSite("https://Meet.Example.com/room?x=1")).toBe("meet.example.com");
        expect(permissionSite("http://localhost:3000/")).toBe("localhost:3000");
        expect(permissionSite("file:///etc/passwd")).toBeNull();
        expect(permissionSite("data:text/html,x")).toBeNull();
        expect(permissionSite("about:blank")).toBeNull();
        expect(permissionSite("")).toBeNull();
    });

    it("applies remembered decisions: all allowed passes, one block denies, the rest asks", () => {
        const store = { "meet.example.com": { camera: "allow", microphone: "block" }, "a.com": { location: "allow" } };
        expect(rememberedVerdict(store, "meet.example.com", ["camera"]).verdict).toBe("allow");
        expect(rememberedVerdict(store, "meet.example.com", ["camera", "microphone"]).verdict).toBe("deny");
        expect(rememberedVerdict(store, "a.com", ["location", "notifications"])).toEqual({
            verdict: "ask",
            kinds: ["notifications"],
        });
        expect(rememberedVerdict(store, "other.com", ["camera"])).toEqual({ verdict: "ask", kinds: ["camera"] });
        expect(rememberedVerdict(store, null, ["camera"]).verdict).toBe("deny");
        expect(rememberedVerdict({}, "a.com", []).verdict).toBe("deny");
    });

    it("answers checks only from decisions kept for good", () => {
        const store = { "meet.example.com": { camera: "allow", notifications: "block" } };
        expect(checkPermission(store, "media", "https://meet.example.com", "video")).toBe(true);
        expect(checkPermission(store, "media", "https://meet.example.com", "audio")).toBe(false);
        expect(checkPermission(store, "notifications", "https://meet.example.com")).toBe(false);
        expect(checkPermission(store, "geolocation", "https://meet.example.com")).toBe(false);
        expect(checkPermission(store, "media", "https://evil.example", "video")).toBe(false);
        expect(checkPermission(store, "fullscreen", "https://evil.example")).toBe(true);
        expect(checkPermission(store, "hid", "https://meet.example.com")).toBe(false);
        expect(checkPermission(store, "clipboard-read", "https://meet.example.com")).toBe(false);
    });

    it("stores Allow and Block, never a dismissal, and only known kinds", () => {
        const allowed = withDecision({}, "meet.example.com", ["camera", "microphone"], "allow");
        expect(allowed).toEqual({ "meet.example.com": { camera: "allow", microphone: "allow" } });
        const blocked = withDecision(allowed, "meet.example.com", ["microphone"], "block");
        expect(blocked["meet.example.com"]).toEqual({ camera: "allow", microphone: "block" });
        expect(withDecision(blocked, "meet.example.com", ["camera"], "dismiss")).toBe(blocked);
        expect(withDecision({}, "x.com", ["hid"], "allow")).toEqual({ "x.com": {} });
        expect(validDecision("allow")).toBe("allow");
        expect(validDecision("block")).toBe("block");
        expect(validDecision("always")).toBe("dismiss");
        expect(validDecision(undefined)).toBe("dismiss");
    });

    it("lists the decisions kept for a site, one per kind (#1980)", () => {
        const store = { "meet.example.com": { camera: "allow", microphone: "block", location: "maybe" } };
        expect(siteDecisions(store, "meet.example.com")).toEqual([
            { kind: "camera", decision: "allow" },
            { kind: "microphone", decision: "block" },
            { kind: "location", decision: "" },
            { kind: "notifications", decision: "" },
        ]);
        expect(siteDecisions({}, "other.com").every((d) => d.decision === "")).toBe(true);
        expect(siteDecisions(undefined, "other.com")).toHaveLength(4);
    });

    it("removes the decision of one kind and the site once it has none left (#1980)", () => {
        const store = { "meet.example.com": { camera: "allow", microphone: "block" }, "a.com": { location: "allow" } };
        const noCamera = withoutDecision(store, "meet.example.com", "camera");
        expect(noCamera).toEqual({ "meet.example.com": { microphone: "block" }, "a.com": { location: "allow" } });
        expect(withoutDecision(noCamera, "meet.example.com", "microphone")).toEqual({ "a.com": { location: "allow" } });
        expect(withoutDecision(store, "meet.example.com", "location")).toBe(store);
        expect(withoutDecision(store, "unknown.com", "camera")).toBe(store);
        expect(withoutDecision(undefined, "a.com", "camera")).toEqual({});
        expect(store["meet.example.com"]).toEqual({ camera: "allow", microphone: "block" });
    });

    it("words what a request asks for", () => {
        expect(sitePermissionWhatKey(["camera", "microphone"])).toBe("browser.sitePermission.what.cameraMicrophone");
        expect(sitePermissionWhatKey(["microphone"])).toBe("browser.sitePermission.what.microphone");
        expect(sitePermissionWhatKey(["location"])).toBe("browser.sitePermission.what.location");
        expect(sitePermissionWhatKey(["notifications"])).toBe("browser.sitePermission.what.notifications");
    });
});
