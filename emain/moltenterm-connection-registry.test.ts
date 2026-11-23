// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { CertificateSummary, ConnectionState } from "../frontend/moltenterm-shell/browser/connection-security";
import { CertificateMemory, ConnectionRegistry } from "./moltenterm-connection-registry";

const cert = (subject: string): CertificateSummary => ({
    subject,
    issuer: "R11",
    validFrom: 1,
    validUntil: 2,
    fingerprint: "AA",
});
const MixedMessage =
    "Mixed Content: The page at 'https://a.example/' was loaded over HTTPS, but requested an insecure image 'http://b.example/x.png'. This content should also be served over HTTPS.";

function make() {
    const sent: [number, ConnectionState][] = [];
    const certificates = new CertificateMemory();
    const registry = new ConnectionRegistry(certificates, (id, state) => sent.push([id, state]));
    return { sent, certificates, registry };
}

describe("the certificates Chromium verified (#1980)", () => {
    it("keeps the latest of a host, by lower-case name", () => {
        const memory = new CertificateMemory();
        memory.note("Example.COM", cert("old"));
        memory.note("example.com", cert("new"));
        expect(memory.get("EXAMPLE.com").subject).toBe("new");
        expect(memory.get("other.example")).toBeNull();
    });

    it("ignores what is not a host and a certificate, and stays bounded", () => {
        const memory = new CertificateMemory();
        memory.note(undefined, cert("x"));
        memory.note("", cert("x"));
        memory.note("a.example", null);
        expect(memory.get("a.example")).toBeNull();
        for (let i = 0; i < 600; i++) {
            memory.note(`h${i}.example`, cert(String(i)));
        }
        expect(memory.get("h0.example")).toBeNull();
        expect(memory.get("h599.example")).not.toBeNull();
    });
});

describe("the state main keeps per guest (#1980)", () => {
    it("reads the committed address, with the certificate of an https page", () => {
        const { registry, certificates, sent } = make();
        certificates.note("a.example", cert("a.example"));
        registry.committed(7, "https://a.example/login", false);
        expect(registry.stateOf(7)).toEqual({
            url: "https://a.example/login",
            mixed: false,
            certificate: cert("a.example"),
        });
        expect(sent).toEqual([[7, registry.stateOf(7)]]);
        registry.committed(7, "http://a.example/", false);
        expect(registry.stateOf(7).certificate).toBeNull();
    });

    it("marks an https document on Chromium's report of insecure content, once", () => {
        const { registry, sent } = make();
        registry.committed(7, "https://a.example/", false);
        registry.consoleMessage(7, MixedMessage);
        registry.consoleMessage(7, MixedMessage);
        expect(registry.stateOf(7).mixed).toBe(true);
        expect(sent).toHaveLength(2);
    });

    it("clears the mark at the next document, keeps it across a move inside the document", () => {
        const { registry } = make();
        registry.committed(7, "https://a.example/", false);
        registry.consoleMessage(7, MixedMessage);
        registry.committed(7, "https://a.example/#section", true);
        expect(registry.stateOf(7).mixed).toBe(true);
        registry.committed(7, "https://a.example/next", false);
        expect(registry.stateOf(7).mixed).toBe(false);
    });

    it("ignores messages that are not Chromium's report, and a report on a page that is not https", () => {
        const { registry, sent } = make();
        registry.consoleMessage(7, MixedMessage);
        registry.committed(7, "http://a.example/", false);
        registry.consoleMessage(7, MixedMessage);
        registry.committed(7, "https://a.example/", false);
        registry.consoleMessage(7, "Uncaught TypeError: x");
        registry.consoleMessage(7, 42);
        expect(registry.stateOf(7).mixed).toBe(false);
        expect(sent).toHaveLength(2);
    });

    it("knows nothing of a guest before its first page and forgets a closed one", () => {
        const { registry } = make();
        expect(registry.stateOf(9)).toBeNull();
        registry.committed(9, "https://a.example/", false);
        registry.forget(9);
        expect(registry.stateOf(9)).toBeNull();
    });

    it("keeps each guest's state apart", () => {
        const { registry } = make();
        registry.committed(1, "https://a.example/", false);
        registry.committed(2, "https://b.example/", false);
        registry.consoleMessage(1, MixedMessage);
        expect(registry.stateOf(1).mixed).toBe(true);
        expect(registry.stateOf(2).mixed).toBe(false);
    });
});
