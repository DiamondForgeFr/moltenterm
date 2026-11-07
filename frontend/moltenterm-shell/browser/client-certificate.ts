// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Client certificates in the browser panel (#1979, FR-BRW-016). A site that asks for a client certificate learns who the
// user is from it (company, name, e-mail), and Electron hands such a site the first certificate of the system store
// without asking. emain/moltenterm-client-certificates.ts applies this rule instead: a certificate is presented only
// when the user picked it for that site in the tab (the bar of client-certificate-bar.tsx, none preselected) and the
// choice, or the choice to go without one, is remembered in browser:clientcertificates. An agent never chooses.
// Pure: shared by emain, the panel's bar and Settings.

import { DecisionDismiss, permissionSite } from "./site-permission";

export const ClientCertificatesKey = "browser:clientcertificates";

// Stored in place of a fingerprint when the user went without a certificate for the site, and the answer that says so.
export const CertificateNone = "none";

export const CertificateUse = "use";

export type ClientCertificateStore = Record<string, string>;

// What the tab shows of one certificate: enough to tell them apart, nothing a page could use.
export type OfferedCertificate = { fingerprint: string; name: string; issuer: string; expires: number };

export type CertificateVerdict = { verdict: "use"; fingerprint: string } | { verdict: "none" } | { verdict: "ask" };

// The user's answer, as main validates it.
export type CertificateAnswer =
    | { decision: "use"; fingerprint: string }
    | { decision: "none" }
    | { decision: "dismiss" };

const MaxTextLength = 200;

// Electron gives the host and port of the request ("example.com:443"); its documentation says a URL. Both are read.
export function clientCertificateSite(requested: string): string {
    if (typeof requested !== "string" || requested === "") {
        return null;
    }
    const direct = permissionSite(requested);
    if (direct != null) {
        return direct;
    }
    if (requested.includes("://")) {
        return null;
    }
    return permissionSite(`https://${requested}`);
}

function text(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }
    let clean = "";
    for (const ch of value) {
        const code = ch.codePointAt(0);
        clean += code < 0x20 || code === 0x7f ? " " : ch;
    }
    return clean.trim().slice(0, MaxTextLength);
}

type RawCertificate = {
    fingerprint?: unknown;
    subjectName?: unknown;
    subject?: { commonName?: unknown };
    issuerName?: unknown;
    issuer?: { commonName?: unknown };
    validExpiry?: unknown;
};

function summarize(raw: RawCertificate): OfferedCertificate {
    const fingerprint = text(raw?.fingerprint);
    if (fingerprint === "") {
        return null;
    }
    const expiry = typeof raw.validExpiry === "number" && Number.isFinite(raw.validExpiry) ? raw.validExpiry : 0;
    return {
        fingerprint,
        name: text(raw.subject?.commonName) || text(raw.subjectName),
        issuer: text(raw.issuer?.commonName) || text(raw.issuerName),
        // Electron counts seconds.
        expires: expiry > 0 ? expiry * 1000 : 0,
    };
}

// The certificates the system offers, once each, without the certificate itself.
export function offeredCertificates(list: unknown): OfferedCertificate[] {
    if (!Array.isArray(list)) {
        return [];
    }
    const seen = new Set<string>();
    const offered: OfferedCertificate[] = [];
    for (const raw of list) {
        const cert = summarize(raw);
        if (cert == null || seen.has(cert.fingerprint)) {
            continue;
        }
        seen.add(cert.fingerprint);
        offered.push(cert);
    }
    return offered;
}

// What the remembered choice says: use the certificate while the system still offers it, go without, or ask.
// A site that is not a web site, or an empty list, has nothing to choose: none.
export function rememberedCertificate(
    store: ClientCertificateStore,
    site: string,
    offered: OfferedCertificate[]
): CertificateVerdict {
    if (site == null || offered.length === 0) {
        return { verdict: "none" };
    }
    const value = store?.[site];
    if (value === CertificateNone) {
        return { verdict: "none" };
    }
    if (typeof value === "string" && offered.some((c) => c.fingerprint === value)) {
        return { verdict: "use", fingerprint: value };
    }
    return { verdict: "ask" };
}

// The store after the user's answer; a dismissal changes nothing.
export function withCertificateChoice(
    store: ClientCertificateStore,
    site: string,
    answer: CertificateAnswer
): ClientCertificateStore {
    if (site == null || answer.decision === DecisionDismiss) {
        return store ?? {};
    }
    return { ...(store ?? {}), [site]: answer.decision === CertificateUse ? answer.fingerprint : CertificateNone };
}

// Only these answers come back from the bar, and a certificate only if it was offered.
export function validCertificateAnswer(
    decision: unknown,
    fingerprint: unknown,
    offered: OfferedCertificate[]
): CertificateAnswer {
    if (decision === CertificateNone) {
        return { decision: "none" };
    }
    if (
        decision === CertificateUse &&
        typeof fingerprint === "string" &&
        offered.some((c) => c.fingerprint === fingerprint)
    ) {
        return { decision: "use", fingerprint };
    }
    return { decision: DecisionDismiss };
}

// The store a settings value holds: strings only.
export function clientCertificateStoreOf(value: unknown): ClientCertificateStore {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const store: ClientCertificateStore = {};
    for (const [site, choice] of Object.entries(value as Record<string, unknown>)) {
        if (typeof choice === "string" && choice !== "") {
            store[site] = choice;
        }
    }
    return store;
}
