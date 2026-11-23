// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    connectionLevel,
    fingerprintHex,
    insecureReason,
    isConnectionState,
    isLocalHost,
    isMixedContentMessage,
    passwordWarningKey,
    summarizeCertificate,
    warnsAboutPassword,
} from "./connection-security";

describe("the local machine (#1980)", () => {
    it("is localhost, its subdomains, the IPv4 loopback block and ::1", () => {
        for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.12.0.9", "::1", "[::1]"]) {
            expect(isLocalHost(host), host).toBe(true);
        }
    });

    it("is not another machine on the network or a name that only looks local", () => {
        for (const host of [
            "",
            "192.168.1.20",
            "10.0.0.1",
            "0.0.0.0",
            "128.0.0.1",
            "127.0.0.256",
            "127.0.0",
            "localhost.example.com",
            "mylocalhost",
            "example.localhost.evil.com",
            "app.local",
        ]) {
            expect(isLocalHost(host), host).toBe(false);
        }
    });
});

describe("the connection level of a page (#1980)", () => {
    it("is secure on https without insecure content", () => {
        expect(connectionLevel("https://example.com/a?b=1#c", false)).toBe("secure");
    });

    it("is insecure on plain http outside the local machine, whatever the port", () => {
        expect(connectionLevel("http://example.com/login", false)).toBe("insecure");
        expect(connectionLevel("http://192.168.1.20:3000/", false)).toBe("insecure");
        expect(insecureReason("http://example.com/login", false)).toBe("http");
    });

    it("is insecure on https that Chromium reported insecure content for", () => {
        expect(connectionLevel("https://example.com/", true)).toBe("insecure");
        expect(insecureReason("https://example.com/", true)).toBe("mixed");
    });

    it("is local on http from the local machine", () => {
        expect(connectionLevel("http://localhost:3000/", false)).toBe("local");
        expect(connectionLevel("http://127.0.0.1:8080/x", false)).toBe("local");
        expect(connectionLevel("http://[::1]:5173/", false)).toBe("local");
    });

    it("is neither on a page that is not a web page", () => {
        for (const address of [
            "",
            "about:blank",
            "about:blank#moltenterm-start",
            "file:///tmp/a.html",
            "data:text/html,x",
            "javascript:1",
            "not a url",
            undefined,
            null,
        ]) {
            expect(connectionLevel(address as string, false), String(address)).toBe("other");
            expect(connectionLevel(address as string, true), String(address)).toBe("other");
        }
    });

    it("does not let a host in the user part or a look-alike name pass as local", () => {
        expect(connectionLevel("http://localhost@evil.example/", false)).toBe("insecure");
        expect(connectionLevel("http://localhost.evil.example/", false)).toBe("insecure");
        expect(connectionLevel("http://127.0.0.1.evil.example/", false)).toBe("insecure");
    });
});

describe("the password warning (#1980)", () => {
    it("is for plain http outside the local machine only", () => {
        expect(warnsAboutPassword("http://example.com/login")).toBe(true);
        expect(warnsAboutPassword("https://example.com/login")).toBe(false);
        expect(warnsAboutPassword("http://localhost:3000/login")).toBe(false);
        expect(warnsAboutPassword("http://127.0.0.1/login")).toBe(false);
        expect(warnsAboutPassword("about:blank")).toBe(false);
        expect(warnsAboutPassword("file:///tmp/a.html")).toBe(false);
    });

    it("keys a page by its tab and its address without the fragment", () => {
        expect(passwordWarningKey("t1", "http://example.com/a#x")).toBe(
            passwordWarningKey("t1", "http://example.com/a#y")
        );
        expect(passwordWarningKey("t1", "http://example.com/a")).not.toBe(
            passwordWarningKey("t1", "http://example.com/b")
        );
        expect(passwordWarningKey("t1", "http://example.com/a")).not.toBe(
            passwordWarningKey("t2", "http://example.com/a")
        );
    });
});

describe("Chromium's insecure content report (#1980)", () => {
    it("recognises allowed content, blocked content and a form to an insecure endpoint", () => {
        for (const message of [
            "Mixed Content: The page at 'https://a.example/' was loaded over HTTPS, but requested an insecure image 'http://b.example/x.png'. This content should also be served over HTTPS.",
            "Mixed Content: The page at 'https://a.example/' was loaded over HTTPS, but requested an insecure script 'http://b.example/x.js'. This request has been blocked; the content must be served over HTTPS.",
            "Mixed Content: The page at 'https://a.example/' was loaded over a secure connection, but contains a form that targets an insecure endpoint 'http://b.example/post'. This endpoint should be made available over a secure connection.",
        ]) {
            expect(isMixedContentMessage(message), message).toBe(true);
        }
    });

    it("ignores an upgrade to https and anything else", () => {
        expect(
            isMixedContentMessage(
                "Mixed Content: The page at 'https://a.example/' was loaded over HTTPS, but requested an insecure image 'http://b.example/x.png'. This request has been automatically upgraded to HTTPS, For more information see https://example.org"
            )
        ).toBe(false);
        for (const message of [
            "",
            "hello",
            "Uncaught TypeError: x",
            "mixed content: lower case",
            undefined,
            null,
            42,
        ]) {
            expect(isMixedContentMessage(message), String(message)).toBe(false);
        }
    });

    it("ignores a message too long to be Chromium's", () => {
        expect(isMixedContentMessage("Mixed Content: " + "x".repeat(5000))).toBe(false);
    });
});

describe("the certificate the popover shows (#1980)", () => {
    const raw = {
        subject: { commonName: "example.com" },
        subjectName: "CN=example.com",
        issuer: { commonName: "R11", organizations: ["Let's Encrypt"] },
        issuerName: "CN=R11,O=Let's Encrypt,C=US",
        validStart: 1760000000,
        validExpiry: 1767000000.7,
        fingerprint: "sha256/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    };

    it("keeps who it was issued to and by, its validity and its fingerprint", () => {
        expect(summarizeCertificate(raw)).toEqual({
            subject: "example.com",
            issuer: "R11",
            validFrom: 1760000000,
            validUntil: 1767000000,
            fingerprint:
                "00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F",
        });
    });

    it("falls back to the organisation, then to the full name", () => {
        expect(summarizeCertificate({ ...raw, issuer: { organizations: ["Acme CA"] } }).issuer).toBe("Acme CA");
        expect(summarizeCertificate({ ...raw, issuer: {}, issuerName: "CN=Old CA" }).issuer).toBe("CN=Old CA");
    });

    it("reads as nothing when there is nothing to show, and bounds what it keeps", () => {
        expect(summarizeCertificate(null)).toBeNull();
        expect(summarizeCertificate("x")).toBeNull();
        expect(summarizeCertificate({})).toBeNull();
        const long = summarizeCertificate({
            ...raw,
            subject: { commonName: "a".repeat(2000) },
            validStart: "x",
            validExpiry: -1,
        });
        expect(long.subject).toHaveLength(300);
        expect(long.validFrom).toBe(0);
        expect(long.validUntil).toBe(0);
    });

    it("turns a base64 fingerprint into hex pairs, and refuses what is not one", () => {
        expect(fingerprintHex("sha256/AAEC")).toBe("00:01:02");
        expect(fingerprintHex("sha256/not base64!")).toBe("");
        expect(fingerprintHex("x".repeat(500))).toBe("");
        expect(fingerprintHex(undefined)).toBe("");
    });
});

describe("the state main sends (#1980)", () => {
    it("accepts the shape and refuses anything else", () => {
        expect(isConnectionState({ url: "https://a.example/", mixed: false, certificate: null })).toBe(true);
        expect(
            isConnectionState({
                url: "https://a.example/",
                mixed: true,
                certificate: { subject: "a", issuer: "b", validFrom: 1, validUntil: 2, fingerprint: "" },
            })
        ).toBe(true);
        for (const value of [
            null,
            undefined,
            "x",
            {},
            { url: 1, mixed: false },
            { url: "u", mixed: "no" },
            { url: "u", mixed: false, certificate: { subject: 1 } },
        ]) {
            expect(isConnectionState(value), JSON.stringify(value)).toBe(false);
        }
    });
});
