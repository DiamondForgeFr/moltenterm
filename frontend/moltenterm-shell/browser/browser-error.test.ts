// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    BrowserErrorModel,
    classifyLoadError,
    errorPageView,
    isLocalHost,
    isPageFailure,
    LoadError,
} from "./browser-error";

describe("error classes (FR-SHELL-051 AC2, DS-SHELL-092)", () => {
    it("sorts Chromium's codes into DNS, refused, timeout, TLS, offline and other", () => {
        expect(classifyLoadError(-105)).toBe("dns");
        expect(classifyLoadError(-137)).toBe("dns");
        expect(classifyLoadError(-102)).toBe("refused");
        expect(classifyLoadError(-118)).toBe("timeout");
        expect(classifyLoadError(-201)).toBe("tls");
        expect(classifyLoadError(-107)).toBe("tls");
        expect(classifyLoadError(-106)).toBe("offline");
        expect(classifyLoadError(-324)).toBe("other");
    });

    it("draws a page only for a main-frame failure that was not aborted", () => {
        expect(isPageFailure({ errorCode: -105, isMainFrame: true })).toBe(true);
        expect(isPageFailure({ errorCode: -105, isMainFrame: false })).toBe(false);
        expect(isPageFailure({ errorCode: -3, isMainFrame: true })).toBe(false);
        expect(isPageFailure({ errorCode: 0, isMainFrame: true })).toBe(false);
    });

    it("recognises local hosts", () => {
        for (const host of ["localhost", "app.localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
            expect(isLocalHost(host), host).toBe(true);
        }
        expect(isLocalHost("example.com")).toBe(false);
    });
});

describe("error page (FR-SHELL-051 AC2)", () => {
    const view = (url: string, code: number, description: string) => errorPageView({ url, code, description });

    it("names the host of a DNS failure and keeps the code for Details", () => {
        const v = view("http://nonexistent.invalid/path?q=1", -105, "ERR_NAME_NOT_RESOLVED");
        expect(v.title).toBe("Can't reach nonexistent.invalid");
        expect(v.hint).toBe("The address could not be found. Check it for typos.");
        expect(v.local).toBe(false);
        expect(v.details).toBe("ERR_NAME_NOT_RESOLVED (-105)");
        // Neither the path nor the query reach the page.
        expect(JSON.stringify(v)).not.toContain("q=1");
    });

    it("tells a refused local port in plain words and offers to start the dev server", () => {
        const v = view("http://localhost:59999/", -102, "ERR_CONNECTION_REFUSED");
        expect(v.title).toBe("Can't reach localhost:59999");
        expect(v.hint).toBe("Nothing is answering on port 59999.");
        expect(v.local).toBe(true);
    });

    it("tells a refused remote server and a TLS error apart", () => {
        expect(view("https://example.com", -102, "ERR_CONNECTION_REFUSED").hint).toBe(
            "The server refused the connection."
        );
        const tls = view("https://expired.badssl.com/", -201, "ERR_CERT_DATE_INVALID");
        expect(tls.errorClass).toBe("tls");
        expect(tls.title).toBe("Can't reach expired.badssl.com");
        expect(tls.local).toBe(false);
    });
});

describe("error state per tab", () => {
    const failure: LoadError = { url: "http://localhost:59999/", code: -102, description: "ERR_CONNECTION_REFUSED" };

    it("keeps the page through a Retry that fails again and clears it on a load that succeeds", () => {
        const errors = new BrowserErrorModel();
        errors.noteStart("t1");
        errors.noteFailure("t1", failure);
        errors.noteStop("t1");
        expect(errors.error("t1")).toEqual(failure);

        errors.noteRetry("t1");
        expect(errors.get("t1").retrying).toBe(true);
        errors.noteStart("t1");
        errors.noteFailure("t1", failure);
        errors.noteStop("t1");
        expect(errors.error("t1")).toEqual(failure);
        expect(errors.get("t1").retrying).toBe(false);

        errors.noteStart("t1");
        errors.noteStop("t1");
        expect(errors.error("t1")).toBeNull();
    });
});
