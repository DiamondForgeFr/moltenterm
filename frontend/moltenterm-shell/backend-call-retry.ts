// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Service calls to wavesrv that could not even connect (#849). On 2026-10-16 every tab click failed for five minutes
// with net::ERR_ADDRESS_INVALID: Chromium's name for EADDRNOTAVAIL, the error connect() returns when the machine has
// no local port left. These errors happen before the request leaves, so trying again cannot run a call twice. Only
// Electron's net module reports them by name; a page's fetch says "Failed to fetch" for any failure and is never
// retried.

export const ConnectPhaseErrors = [
    "ERR_ADDRESS_INVALID",
    "ERR_ADDRESS_IN_USE",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_CONNECTION_REFUSED",
    "ERR_INSUFFICIENT_RESOURCES",
];

export const BackendRetryDelaysMs = [250, 500, 1000];

export type BackendCallReporter = (line: string) => void;

let reporter: BackendCallReporter = null;

// Electron main records the retries in its hang diagnostics.
export function setBackendCallReporter(fn: BackendCallReporter) {
    reporter = fn;
}

export function connectPhaseError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e ?? "");
    return ConnectPhaseErrors.find((code) => message.includes(`net::${code}`)) ?? null;
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithConnectRetry(
    doFetch: () => Promise<Response>,
    methodName: string,
    sleep: (ms: number) => Promise<void> = sleepMs,
    delays: number[] = BackendRetryDelaysMs
): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await doFetch();
        } catch (e) {
            const code = connectPhaseError(e);
            const message = e instanceof Error ? e.message : String(e);
            if (code == null || attempt >= delays.length) {
                if (code != null) {
                    reporter?.(`service call ${methodName} failed after ${attempt + 1} attempts: ${code}`);
                }
                const err = new Error(`call ${methodName} failed: ${message}`);
                (err as any).cause = e;
                throw err;
            }
            reporter?.(`service call ${methodName} could not connect (${code}), attempt ${attempt + 1}`);
            await sleep(delays[attempt]);
        }
    }
}
