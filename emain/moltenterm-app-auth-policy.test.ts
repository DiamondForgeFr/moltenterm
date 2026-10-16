// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    callerProof,
    isBackendDestination,
    permitsCredentialResource,
    stripBackendCredentials,
    TrustedAppCallers,
} from "./moltenterm-app-auth-policy";

function fixture(url = "file:///app/frontend/index.html") {
    const session = {};
    const frame = { url };
    const contents = { id: 1, session, mainFrame: frame, isDestroyed: () => false, getURL: () => url };
    const callers = new TrustedAppCallers();
    callers.register(contents, session, url);
    return { callers, contents, frame, session };
}

describe("registered application caller", () => {
    it.each(["file:///app/frontend/index.html", "http://localhost:5173/index.html"])(
        "accepts the exact registered live main frame: %s",
        (url) => {
            const { callers, contents, frame } = fixture(url);
            expect(callers.allows(contents, frame)).toBe(true);
        }
    );

    it("rejects guests and popups even with the same URL, session and copied ID", () => {
        const { callers, contents, frame } = fixture();
        expect(callers.allows({ ...contents }, frame)).toBe(false);
        expect(callers.allows({ ...contents, id: 2 }, frame)).toBe(false);
    });

    it("rejects subframes, missing frames and retired main frames", () => {
        const { callers, contents, frame } = fixture();
        expect(callers.allows(contents, { ...frame })).toBe(false);
        expect(callers.allows(contents, null)).toBe(false);
        contents.mainFrame = { ...frame };
        expect(callers.allows(contents, frame)).toBe(false);
    });

    it.each(["http://localhost:5173/evil", "file:///app/frontend/other.html", "https://example.test"])(
        "rejects navigation away from the registered document: %s",
        (url) => {
            const { callers, contents, frame } = fixture();
            frame.url = url;
            expect(callers.allows(contents, frame)).toBe(false);
            contents.getURL = () => url;
            expect(callers.allows(contents, frame)).toBe(false);
        }
    );

    it("rejects changed sessions, destroyed contents and detached frame getters", () => {
        const { callers, contents, frame, session } = fixture();
        contents.session = {};
        expect(callers.allows(contents, frame)).toBe(false);
        contents.session = session;
        contents.isDestroyed = () => true;
        expect(callers.allows(contents, frame)).toBe(false);
        contents.isDestroyed = () => false;
        contents.getURL = () => {
            throw new Error("destroyed");
        };
        expect(callers.allows(contents, frame)).toBe(false);
    });

    it("revokes registration on disposal without revoking a replacement object", () => {
        const { callers, contents, frame, session } = fixture();
        callers.forget({ ...contents });
        expect(callers.allows(contents, frame)).toBe(true);
        callers.forget(contents);
        expect(callers.allows(contents, frame)).toBe(false);
        callers.register(contents, session, frame.url);
        expect(callers.allows(contents, frame)).toBe(true);
    });
});

describe("backend credential policy", () => {
    const endpoints = ["http://127.0.0.1:1234", "ws://127.0.0.1:4321"];

    it.each(["http://127.0.0.1:1234/wave/service", "ws://127.0.0.1:4321/ws"])("accepts exact endpoint %s", (url) => {
        expect(isBackendDestination(url, endpoints)).toBe(true);
    });

    it.each([
        "http://127.0.0.1:12345/",
        "http://127.0.0.1:4321/",
        "http://localhost:1234/",
        "https://127.0.0.1:1234/",
        "http://user@127.0.0.1:1234/",
        "http://127.0.0.1.example.test:1234/",
        "invalid",
    ])("rejects nonexact destination %s", (url) => {
        expect(isBackendDestination(url, endpoints)).toBe(false);
    });

    it("denies navigations even when their initiating frame is trusted", () => {
        expect(permitsCredentialResource("mainFrame")).toBe(false);
        expect(permitsCredentialResource("subFrame")).toBe(false);
        for (const type of ["xhr", "image", "media", "webSocket"]) expect(permitsCredentialResource(type)).toBe(true);
    });

    it("removes all casing variants of privileged headers", () => {
        expect(
            stripBackendCredentials({
                "X-AUTHKEY": "key",
                "x-molten-caller": "main",
                "X-Molten-Proof": "proof",
                Range: "bytes=0-1",
            })
        ).toEqual({ Range: "bytes=0-1" });
    });

    it("separates caller classes and startup secrets", () => {
        // Shared Node/Go vector guards the process boundary's encoding and domain separator.
        expect(callerProof("a separate random proof secret, not the renderer auth key", "renderer")).toBe(
            "7af68741fcf61f4332f27be8bfa71b6c9edd8d043be94ea8721db625518d8d62"
        );
        const renderer = callerProof("separate-proof-secret", "renderer");
        expect(renderer).toMatch(/^[a-f0-9]{64}$/);
        expect(renderer).not.toBe(callerProof("separate-proof-secret", "main"));
        expect(renderer).not.toBe(callerProof("renderer-visible-auth-key", "renderer"));
    });
});
