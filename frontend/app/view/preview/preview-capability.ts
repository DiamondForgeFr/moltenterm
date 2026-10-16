// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { getWebServerEndpoint } from "@/util/endpoints";
import { fetch } from "@/util/fetchutil";

// Only the app main frame calls this controller; the iframe receives a file-scoped URL and no app credentials.
export function leasePDFPreview(path: string, onUrl: (url: string) => void, onError: () => void): () => void {
    const endpoint = `${getWebServerEndpoint()}/wave/preview-resource`;
    let disposed = false;
    let pending = false;
    let token = "";
    const resourceUrl = (value: string) => `${endpoint}/${value}`;
    const revoke = (value: string) => {
        if (value) void fetch(resourceUrl(value), { method: "DELETE", redirect: "error" }).catch(() => {});
    };
    const refresh = async () => {
        if (disposed || pending) return;
        pending = true;
        try {
            if (token) {
                const renewed = await fetch(resourceUrl(token), { method: "POST", redirect: "error" });
                if (disposed || renewed.ok) return;
                if (renewed.status !== 404) throw new Error("preview renewal failed");
                token = "";
            }
            const response = await fetch(endpoint, {
                method: "POST",
                redirect: "error",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            if (!response.ok) throw new Error("preview unavailable");
            const result = await response.json();
            if (!/^[a-f0-9]{64}$/.test(result.token)) throw new Error("invalid preview resource");
            if (disposed) {
                revoke(result.token);
            } else {
                token = result.token;
                onUrl(resourceUrl(token));
            }
        } catch {
            if (!disposed) onError();
        } finally {
            pending = false;
        }
    };
    void refresh();
    // Keep mounted previews usable without reloading the native PDF viewer or renewing from the iframe itself.
    const interval = setInterval(() => void refresh(), 60_000);
    return () => {
        disposed = true;
        clearInterval(interval);
        revoke(token);
        token = "";
    };
}
