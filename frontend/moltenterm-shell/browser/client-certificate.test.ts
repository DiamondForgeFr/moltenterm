// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    CertificateNone,
    clientCertificateSite,
    clientCertificateStoreOf,
    offeredCertificates,
    rememberedCertificate,
    validCertificateAnswer,
    withCertificateChoice,
} from "./client-certificate";

const Alice = {
    fingerprint: "sha256/alice",
    subjectName: "CN=Alice,O=Acme",
    subject: { commonName: "Alice" },
    issuerName: "CN=Acme CA",
    issuer: { commonName: "Acme CA" },
    validExpiry: 1_900_000_000,
    data: "-----BEGIN CERTIFICATE-----secret-----END CERTIFICATE-----",
};
const Work = { fingerprint: "sha256/work", subjectName: "CN=work", issuerName: "CN=Root", validExpiry: 0 };

describe("the site a client certificate request is for (#1979)", () => {
    it("reads the host and port Electron gives, and a URL", () => {
        expect(clientCertificateSite("example.com:443")).toBe("example.com");
        expect(clientCertificateSite("Example.com:8443")).toBe("example.com:8443");
        expect(clientCertificateSite("[::1]:8443")).toBe("[::1]:8443");
        expect(clientCertificateSite("https://Example.com/path?x=1")).toBe("example.com");
        expect(clientCertificateSite("http://localhost:3000/")).toBe("localhost:3000");
    });

    it("has no site for what is not a web address", () => {
        expect(clientCertificateSite("")).toBeNull();
        expect(clientCertificateSite(undefined)).toBeNull();
        expect(clientCertificateSite("file:///etc/hosts")).toBeNull();
        expect(clientCertificateSite("javascript://x")).toBeNull();
    });
});

describe("the certificates the tab shows (#1979)", () => {
    it("keeps a name, an issuer and an expiry, and never the certificate itself", () => {
        const [alice, work] = offeredCertificates([Alice, Work]);
        expect(alice).toEqual({
            fingerprint: "sha256/alice",
            name: "Alice",
            issuer: "Acme CA",
            expires: 1_900_000_000_000,
        });
        expect(work).toEqual({ fingerprint: "sha256/work", name: "CN=work", issuer: "CN=Root", expires: 0 });
        expect(JSON.stringify([alice, work])).not.toContain("secret");
    });

    it("drops a certificate without a fingerprint and lists each one once", () => {
        const offered = offeredCertificates([Alice, { subjectName: "CN=nobody" }, null, Alice, "x"]);
        expect(offered.map((c) => c.fingerprint)).toEqual(["sha256/alice"]);
        expect(offeredCertificates(undefined)).toEqual([]);
        expect(offeredCertificates("sha256/alice")).toEqual([]);
    });

    it("cleans control characters and caps the length of what it shows", () => {
        const [cert] = offeredCertificates([
            { fingerprint: "sha256/x", subjectName: `CN=a\u0000b\nc${"z".repeat(500)}` },
        ]);
        expect(Array.from(cert.name).every((ch) => ch.codePointAt(0) >= 0x20)).toBe(true);
        expect(cert.name.length).toBe(200);
    });
});

describe("what is remembered for a site (#1979)", () => {
    const offered = offeredCertificates([Alice, Work]);

    it("asks while nothing is remembered, and never picks the first certificate", () => {
        expect(rememberedCertificate({}, "example.com", offered)).toEqual({ verdict: "ask" });
        expect(rememberedCertificate(null, "example.com", offered)).toEqual({ verdict: "ask" });
        expect(rememberedCertificate({ "other.com": "sha256/alice" }, "example.com", offered)).toEqual({
            verdict: "ask",
        });
    });

    it("uses the remembered certificate while the system still offers it", () => {
        expect(rememberedCertificate({ "example.com": "sha256/work" }, "example.com", offered)).toEqual({
            verdict: "use",
            fingerprint: "sha256/work",
        });
    });

    it("asks again once the remembered certificate is gone", () => {
        expect(rememberedCertificate({ "example.com": "sha256/removed" }, "example.com", offered)).toEqual({
            verdict: "ask",
        });
    });

    it("goes without when the user chose to, and when there is nothing to choose", () => {
        expect(rememberedCertificate({ "example.com": CertificateNone }, "example.com", offered)).toEqual({
            verdict: "none",
        });
        expect(rememberedCertificate({}, "example.com", [])).toEqual({ verdict: "none" });
        expect(rememberedCertificate({}, null, offered)).toEqual({ verdict: "none" });
    });
});

describe("the user's answer (#1979)", () => {
    const offered = offeredCertificates([Alice, Work]);

    it("accepts only a certificate that was offered", () => {
        expect(validCertificateAnswer("use", "sha256/alice", offered)).toEqual({
            decision: "use",
            fingerprint: "sha256/alice",
        });
        expect(validCertificateAnswer("use", "sha256/forged", offered)).toEqual({ decision: "dismiss" });
        expect(validCertificateAnswer("use", undefined, offered)).toEqual({ decision: "dismiss" });
        expect(validCertificateAnswer("use", 3, offered)).toEqual({ decision: "dismiss" });
    });

    it("reads going without, and takes anything else for a dismissal", () => {
        expect(validCertificateAnswer("none", undefined, offered)).toEqual({ decision: "none" });
        expect(validCertificateAnswer("dismiss", undefined, offered)).toEqual({ decision: "dismiss" });
        expect(validCertificateAnswer("allow", "sha256/alice", offered)).toEqual({ decision: "dismiss" });
        expect(validCertificateAnswer(undefined, undefined, offered)).toEqual({ decision: "dismiss" });
    });

    it("remembers a pick or a refusal per site, and nothing for a dismissal", () => {
        const store = { "a.com": "sha256/alice" };
        expect(withCertificateChoice(store, "b.com", { decision: "use", fingerprint: "sha256/work" })).toEqual({
            "a.com": "sha256/alice",
            "b.com": "sha256/work",
        });
        expect(withCertificateChoice(store, "a.com", { decision: "none" })).toEqual({ "a.com": CertificateNone });
        expect(withCertificateChoice(store, "a.com", { decision: "dismiss" })).toBe(store);
        expect(withCertificateChoice(store, null, { decision: "none" })).toBe(store);
        expect(store).toEqual({ "a.com": "sha256/alice" });
    });
});

describe("the stored choices (#1979)", () => {
    it("keeps strings only", () => {
        expect(clientCertificateStoreOf({ "a.com": "sha256/x", "b.com": 3, "c.com": "", "d.com": null })).toEqual({
            "a.com": "sha256/x",
        });
        expect(clientCertificateStoreOf(null)).toEqual({});
        expect(clientCertificateStoreOf(["a.com"])).toEqual({});
        expect(clientCertificateStoreOf("a.com")).toEqual({});
    });
});
