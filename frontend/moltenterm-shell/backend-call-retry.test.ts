// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BackendRetryDelaysMs,
    connectPhaseError,
    fetchWithConnectRetry,
    setBackendCallReporter,
} from "./backend-call-retry";

const ok = { ok: true } as Response;
const noSleep = async () => {};

describe("service calls that could not connect (#849)", () => {
    afterEach(() => setBackendCallReporter(null));

    it("recognises the errors raised before a request leaves", () => {
        expect(connectPhaseError(new Error("net::ERR_ADDRESS_INVALID"))).toBe("ERR_ADDRESS_INVALID");
        expect(connectPhaseError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe("ERR_CONNECTION_REFUSED");
        expect(connectPhaseError(new Error("net::ERR_CONNECTION_RESET"))).toBeNull();
        expect(connectPhaseError(new TypeError("Failed to fetch"))).toBeNull();
    });

    it("tries again after ERR_ADDRESS_INVALID and returns the answer", async () => {
        const lines: string[] = [];
        setBackendCallReporter((line) => lines.push(line));
        const doFetch = vi
            .fn()
            .mockRejectedValueOnce(new Error("net::ERR_ADDRESS_INVALID"))
            .mockRejectedValueOnce(new Error("net::ERR_ADDRESS_INVALID"))
            .mockResolvedValueOnce(ok);
        await expect(fetchWithConnectRetry(doFetch, "workspace.SetActiveTab", noSleep)).resolves.toBe(ok);
        expect(doFetch).toHaveBeenCalledTimes(3);
        expect(lines[0]).toContain("workspace.SetActiveTab could not connect (ERR_ADDRESS_INVALID)");
    });

    it("gives up after the last delay, naming the call", async () => {
        const doFetch = vi.fn().mockRejectedValue(new Error("net::ERR_ADDRESS_INVALID"));
        await expect(fetchWithConnectRetry(doFetch, "workspace.SetActiveTab", noSleep)).rejects.toThrow(
            "call workspace.SetActiveTab failed: net::ERR_ADDRESS_INVALID"
        );
        expect(doFetch).toHaveBeenCalledTimes(BackendRetryDelaysMs.length + 1);
    });

    it("never repeats a call whose failure may come after the request left", async () => {
        const doFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(fetchWithConnectRetry(doFetch, "object.GetObject", noSleep)).rejects.toThrow(
            "call object.GetObject failed: Failed to fetch"
        );
        expect(doFetch).toHaveBeenCalledTimes(1);
    });
});
