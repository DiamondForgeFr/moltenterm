// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Electron main keeps about the connection of each webview guest (#1980, FR-BRW-023, DS-BRW-028), without Electron
// so the rules are tested alone: the committed address, whether Chromium reported insecure content for the document,
// and the certificates Chromium verified. emain/moltenterm-connection.ts feeds it and sends what it says to the window.

import {
    ConnectionState,
    isMixedContentMessage,
    type CertificateSummary,
} from "../frontend/moltenterm-shell/browser/connection-security";

const MaxCertificates = 500;

// The certificates Chromium verified, by host, the most recent kept: memory only, never written anywhere.
export class CertificateMemory {
    private byHost = new Map<string, CertificateSummary>();

    note(hostname: unknown, certificate: CertificateSummary): void {
        if (typeof hostname !== "string" || hostname === "" || certificate == null) {
            return;
        }
        const host = hostname.toLowerCase();
        this.byHost.delete(host);
        this.byHost.set(host, certificate);
        if (this.byHost.size > MaxCertificates) {
            this.byHost.delete(this.byHost.keys().next().value);
        }
    }

    get(hostname: string): CertificateSummary {
        return this.byHost.get((hostname ?? "").toLowerCase()) ?? null;
    }
}

type GuestState = { url: string; mixed: boolean };

function parse(address: string): URL {
    try {
        return new URL(address);
    } catch {
        return null;
    }
}

export class ConnectionRegistry {
    private guests = new Map<number, GuestState>();

    constructor(
        private certificates: CertificateMemory,
        private emit: (webContentsId: number, state: ConnectionState) => void
    ) {}

    // The main frame committed a page. A same-document move (a fragment, history.pushState) keeps the document's report.
    committed(webContentsId: number, address: string, sameDocument: boolean): void {
        const before = this.guests.get(webContentsId);
        const keep = sameDocument && before != null;
        this.guests.set(webContentsId, { url: address, mixed: keep ? before.mixed : false });
        this.emit(webContentsId, this.stateOf(webContentsId));
    }

    // A console message of the guest: Chromium's report of insecure content on a secure page marks the document.
    consoleMessage(webContentsId: number, message: unknown): void {
        const guest = this.guests.get(webContentsId);
        if (
            guest == null ||
            guest.mixed ||
            !isMixedContentMessage(message) ||
            parse(guest.url)?.protocol !== "https:"
        ) {
            return;
        }
        guest.mixed = true;
        this.emit(webContentsId, this.stateOf(webContentsId));
    }

    stateOf(webContentsId: number): ConnectionState {
        const guest = this.guests.get(webContentsId);
        if (guest == null) {
            return null;
        }
        const url = parse(guest.url);
        return {
            url: guest.url,
            mixed: guest.mixed,
            certificate: url?.protocol === "https:" ? this.certificates.get(url.hostname) : null,
        };
    }

    forget(webContentsId: number): void {
        this.guests.delete(webContentsId);
    }
}
