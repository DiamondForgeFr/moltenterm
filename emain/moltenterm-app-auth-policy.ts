// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

export const AppSessionPartition = "moltenterm-trusted-app-v1";
export const CallerHeader = "X-Molten-Caller";
export const CallerProofHeader = "X-Molten-Proof";
export const CallerSecretEnv = "WAVETERM_CALLER_SECRET";
export const AppOriginEnv = "WAVETERM_APP_ORIGIN";
export type AppCaller = "renderer" | "main";

// This secret is separate from the renderer-visible legacy auth key and never leaves main/backend processes.
export function callerProof(secret: string, caller: AppCaller): string {
    return createHmac("sha256", secret).update(`moltenterm-app-caller:v1:${caller}`).digest("hex");
}

type Frame = { readonly url: string };
type Contents = {
    readonly id: number;
    readonly session: object;
    readonly mainFrame: Frame;
    isDestroyed(): boolean;
    getURL(): string;
};
type Registration = { contents: Contents; session: object; documentUrl: string };

// Registration is a capability granted only by app view constructors, never inferred from a URL or partition.
export class TrustedAppCallers {
    private readonly registrations = new Map<number, Registration>();

    register(contents: Contents, session: object, documentUrl: string): void {
        this.registrations.set(contents.id, { contents, session, documentUrl });
    }

    forget(contents: Contents): void {
        if (this.registrations.get(contents.id)?.contents === contents) {
            this.registrations.delete(contents.id);
        }
    }

    allows(contents: Contents | null | undefined, frame: Frame | null | undefined): boolean {
        try {
            if (!contents || !frame || contents.isDestroyed()) return false;
            const registration = this.registrations.get(contents.id);
            return (
                registration?.contents === contents &&
                registration.session === contents.session &&
                frame === contents.mainFrame &&
                contents.getURL() === registration.documentUrl &&
                frame.url === registration.documentUrl
            );
        } catch {
            // Electron frame getters may throw once a frame has been detached or destroyed.
            return false;
        }
    }
}

export function isBackendDestination(url: string, endpoints: readonly string[]): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) return false;
        return endpoints.some((endpoint) => parsed.origin === new URL(endpoint).origin);
    } catch {
        return false;
    }
}

export function permitsCredentialResource(resourceType: string): boolean {
    // A navigation may still name the previous trusted document as its requesting frame.
    return resourceType !== "mainFrame" && resourceType !== "subFrame";
}

export function isPDFPreviewDestination(url: string, endpoint: string): boolean {
    if (!isBackendDestination(url, [endpoint])) return false;
    const parsed = new URL(url);
    return /^\/wave\/preview-resource\/[a-f0-9]{64}$/.test(parsed.pathname) && !parsed.search;
}

export function stripBackendCredentials(headers: Record<string, string>): Record<string, string> {
    const stripped = { ...headers };
    for (const name of Object.keys(stripped)) {
        if (["x-authkey", CallerHeader.toLowerCase(), CallerProofHeader.toLowerCase()].includes(name.toLowerCase())) {
            delete stripped[name];
        }
    }
    return stripped;
}
