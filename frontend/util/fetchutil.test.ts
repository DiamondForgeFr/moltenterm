// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { configureNativeFetchPolicy, fetch } from "./fetchutil";
const env = vi.hoisted(() => ({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }));
vi.mock("electron", () => ({ net: { fetch: env.fetch } }));

it("awaits native transport readiness and preserves Request data through the caller policy", async () => {
    configureNativeFetchPolicy((_url, init) => {
        const headers = new Headers(init.headers);
        headers.set("X-Test-Proof", "native");
        return { ...init, headers, redirect: "error" };
    });
    const request = new Request("http://127.0.0.1:1234/info", {
        method: "POST",
        body: "metadata",
        headers: { Accept: "application/json" },
    });
    await fetch(request, { headers: { "X-Other": "kept" } });
    expect(env.fetch).toHaveBeenCalledOnce();
    expect(env.fetch.mock.calls[0][0]).toBe(request);
    const init = env.fetch.mock.calls[0][1];
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init.headers).get("X-Other")).toBe("kept");
    expect(new Headers(init.headers).get("X-Test-Proof")).toBe("native");
    expect(init.redirect).toBe("error");
    expect(await request.text()).toBe("metadata");
});
