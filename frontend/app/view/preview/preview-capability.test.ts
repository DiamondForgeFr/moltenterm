// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leasePDFPreview } from "./preview-capability";
const env = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/util/fetchutil", () => ({ fetch: env.fetch }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://127.0.0.1:12345" }));
const token = "a".repeat(64);
const token2 = "b".repeat(64);
const minted = (value = token) => new Response(JSON.stringify({ token: value }), { status: 200 });
const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
    vi.useFakeTimers();
    env.fetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("PDF resource lease", () => {
    it("renews without reloading the viewer and revokes on disposal", async () => {
        env.fetch.mockResolvedValueOnce(minted()).mockResolvedValue(new Response(null, { status: 204 }));
        const onUrl = vi.fn();
        const onError = vi.fn();
        const dispose = leasePDFPreview("wsh://local/test.pdf", onUrl, onError);
        await flush();
        expect(onUrl).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:12345/wave/preview-resource/${token}`);
        expect(JSON.parse(env.fetch.mock.calls[0][1].body)).toEqual({ path: "wsh://local/test.pdf" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onUrl).toHaveBeenCalledOnce();
        expect(env.fetch.mock.calls[1][1].method).toBe("POST");
        dispose();
        expect(env.fetch.mock.calls[2][1].method).toBe("DELETE");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(env.fetch).toHaveBeenCalledTimes(3);
        expect(onError).not.toHaveBeenCalled();
    });

    it("revokes an in-flight mint that completes after the view is disposed", async () => {
        let resolve: (response: Response) => void;
        env.fetch
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((done) => {
                        resolve = done;
                    })
            )
            .mockResolvedValue(new Response(null, { status: 204 }));
        const onUrl = vi.fn();
        const dispose = leasePDFPreview("wsh://local/test.pdf", onUrl, vi.fn());
        dispose();
        resolve(minted());
        await flush();
        expect(onUrl).not.toHaveBeenCalled();
        expect(env.fetch.mock.calls[1][0]).toContain(token);
        expect(env.fetch.mock.calls[1][1].method).toBe("DELETE");
    });

    it("remints an expired capability and reports failures without exposing arbitrary URLs", async () => {
        env.fetch
            .mockResolvedValueOnce(minted())
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(minted(token2));
        const onUrl = vi.fn();
        const onError = vi.fn();
        const dispose = leasePDFPreview("wsh://local/test.pdf", onUrl, onError);
        await flush();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onUrl.mock.calls[1][0]).toContain(token2);
        env.fetch.mockResolvedValue(new Response(null, { status: 403 }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onError).toHaveBeenCalledOnce();
        dispose();
        env.fetch.mockResolvedValue(minted("https://example.test/"));
        const badUrl = vi.fn();
        const badError = vi.fn();
        const badDispose = leasePDFPreview("wsh://local/test.pdf", badUrl, badError);
        await flush();
        expect(badUrl).not.toHaveBeenCalled();
        expect(badError).toHaveBeenCalledOnce();
        badDispose();
    });
});
