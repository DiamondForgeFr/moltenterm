// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Utility to abstract the fetch function so the Electron net module can be used when available.

// MOLTENTERM-PATCH (#805): native transports share one caller policy, including the global-fetch fallback.
const nativeNet = typeof window === "undefined" ? import("electron").then(({ net }) => net).catch(() => null) : null;
type NativeFetchPolicy = (url: string, init: RequestInit) => RequestInit;
let nativeFetchPolicy: NativeFetchPolicy;

export function configureNativeFetchPolicy(policy: NativeFetchPolicy): void {
    if (typeof window !== "undefined") throw new Error("Native fetch policy is main-process only");
    nativeFetchPolicy = policy;
}

export async function fetch(input: string | GlobalRequest | URL, init?: RequestInit): Promise<Response> {
    if (typeof window !== "undefined") return globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(typeof input === "object" && "headers" in input ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const options = nativeFetchPolicy ? nativeFetchPolicy(url, { ...init, headers }) : init;
    const net = await nativeNet;
    if (net) {
        return net.fetch(input instanceof URL ? input.href : input, options);
    } else {
        return globalThis.fetch(input, options);
    }
}
