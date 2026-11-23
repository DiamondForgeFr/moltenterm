// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the page of a browser panel tab is served (#1980, FR-BRW-023). The address bar hides the scheme, so a sign-in
// page on plain http looked like the https one. Electron main reads the committed address of the guest, Chromium's
// report of insecure content and the verified certificate (emain/moltenterm-connection.ts); this module decides what
// that means for the developer. Pure: shared by emain and the panel. It only informs, it never blocks anything.

import base64Js from "base64-js";

// The web page preload to the host window, over the webview element's ipc-message: a password field exists on the page.
export const InsecurePasswordChannel = "moltenterm-insecure-password";

export const LevelSecure = "secure";
export const LevelInsecure = "insecure";
export const LevelLocal = "local";
export const LevelOther = "other";
export type ConnectionLevel = typeof LevelSecure | typeof LevelInsecure | typeof LevelLocal | typeof LevelOther;

export const ReasonHttp = "http";
export const ReasonMixed = "mixed";

// A certificate Chromium verified, as the popover shows it. Times are seconds since the epoch.
export type CertificateSummary = {
    subject: string;
    issuer: string;
    validFrom: number;
    validUntil: number;
    fingerprint: string;
};

export type ConnectionState = {
    url: string;
    mixed: boolean;
    certificate: CertificateSummary | null;
};

const MaxUrlChars = 8192;
const MaxFieldChars = 300;
const MixedContentPrefix = "Mixed Content: ";
const UpgradedMarker = "automatically upgraded";

function webUrl(address: string): URL {
    if (typeof address !== "string" || address.length > MaxUrlChars) {
        return null;
    }
    try {
        const url = new URL(address);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url : null;
    } catch {
        return null;
    }
}

function isLoopbackV4(host: string): boolean {
    const parts = host.split(".");
    if (parts.length !== 4 || parts[0] !== "127") {
        return false;
    }
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// The local machine: a page served from it never crosses a network, so plain http is no risk there.
export function isLocalHost(hostname: string): boolean {
    const host = (hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "") {
        return false;
    }
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        isLoopbackV4(host) ||
        host === "::1" ||
        host === "0:0:0:0:0:0:0:1"
    );
}

// What the connection of a page is. other: not a web page (the start page, a local file, an error document).
export function connectionLevel(address: string, mixed: boolean): ConnectionLevel {
    const url = webUrl(address);
    if (url == null) {
        return LevelOther;
    }
    if (url.protocol === "https:") {
        return mixed ? LevelInsecure : LevelSecure;
    }
    return isLocalHost(url.hostname) ? LevelLocal : LevelInsecure;
}

// Why a page is not secure, for the chip and the popover.
export function insecureReason(address: string, mixed: boolean): string {
    return webUrl(address)?.protocol === "https:" && mixed ? ReasonMixed : ReasonHttp;
}

// A password typed on this page crosses the network in the clear.
export function warnsAboutPassword(address: string): boolean {
    const url = webUrl(address);
    return url != null && url.protocol === "http:" && !isLocalHost(url.hostname);
}

// A page's identity for "once per page": its address without the fragment.
export function passwordWarningKey(tabId: string, address: string): string {
    const url = webUrl(address);
    if (url == null) {
        return `${tabId}|`;
    }
    url.hash = "";
    return `${tabId}|${url.href}`;
}

// Chromium's console report of insecure content (allowed or blocked). An upgrade to https is not insecure content.
// A page can write such a message itself, which can only make it look less secure.
export function isMixedContentMessage(message: unknown): boolean {
    return (
        typeof message === "string" &&
        message.startsWith(MixedContentPrefix) &&
        message.length <= 4096 &&
        !message.includes(UpgradedMarker)
    );
}

function field(value: unknown): string {
    return typeof value === "string" ? value.slice(0, MaxFieldChars) : "";
}

type RawPrincipal = {
    commonName?: unknown;
    organizations?: unknown;
};

function principalName(principal: RawPrincipal, fallback: unknown): string {
    const organization = Array.isArray(principal?.organizations) ? field(principal.organizations[0]) : "";
    return field(principal?.commonName) || organization || field(fallback);
}

// "sha256/<base64>" as Electron gives it, as the upper-case hex pairs a certificate viewer shows.
export function fingerprintHex(fingerprint: unknown): string {
    if (typeof fingerprint !== "string") {
        return "";
    }
    const base64 = fingerprint.replace(/^sha256\//, "");
    if (base64.length > 200 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
        return "";
    }
    let bytes: Uint8Array;
    try {
        bytes = base64Js.toByteArray(base64);
    } catch {
        return "";
    }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function seconds(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// The few fields of Electron's Certificate the popover shows, bounded. null when there is nothing to show.
export function summarizeCertificate(raw: any): CertificateSummary {
    if (raw == null || typeof raw !== "object") {
        return null;
    }
    const summary: CertificateSummary = {
        subject: principalName(raw.subject, raw.subjectName),
        issuer: principalName(raw.issuer, raw.issuerName),
        validFrom: seconds(raw.validStart),
        validUntil: seconds(raw.validExpiry),
        fingerprint: fingerprintHex(raw.fingerprint),
    };
    return summary.subject === "" && summary.issuer === "" ? null : summary;
}

export function isConnectionState(value: any): value is ConnectionState {
    if (
        value == null ||
        typeof value !== "object" ||
        typeof value.url !== "string" ||
        typeof value.mixed !== "boolean"
    ) {
        return false;
    }
    const cert = value.certificate;
    if (cert == null) {
        return true;
    }
    return (
        typeof cert.subject === "string" &&
        typeof cert.issuer === "string" &&
        typeof cert.validFrom === "number" &&
        typeof cert.validUntil === "number" &&
        typeof cert.fingerprint === "string"
    );
}
