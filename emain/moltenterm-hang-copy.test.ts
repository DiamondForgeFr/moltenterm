// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), writeText: vi.fn() }));
vi.mock("electron", () => ({ app: { on: vi.fn() }, powerMonitor: { on: vi.fn() }, clipboard: { writeText: mocks.writeText } }));
vi.mock("../frontend/moltenterm-shell/backend-call-retry", () => ({ setBackendCallReporter: vi.fn() }));
vi.mock("./emain-wavesrv", () => ({ getWaveVersion: vi.fn() }));
vi.mock("./emain-window", () => ({ getAllWaveWindows: vi.fn() }));
vi.mock("./moltenterm-privileged-ipc", () => ({ handleAppIpc: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler), onAppIpc: vi.fn() }));
vi.mock("./moltenterm-renderer-gone", () => ({ initRendererGoneRecovery: vi.fn(), onRendererGone: vi.fn(), trackRendererPid: vi.fn() }));

import { HangCopyChannel } from "./moltenterm-hang-ipc";
import { initMoltentermHangWatch } from "./moltenterm-hang-watch";

it("waits for the bounded clipboard write and propagates a failure to the caller", async () => {
    vi.useFakeTimers();
    try {
        initMoltentermHangWatch();
        let reject!: (error: Error) => void;
        const write = new Promise<void>((_resolve, fail) => { reject = fail; });
        mocks.writeText.mockReturnValueOnce(write);
        const result = mocks.handlers.get(HangCopyChannel)!(null, "x".repeat(200001));
        expect(mocks.writeText).toHaveBeenCalledWith("x".repeat(200000));
        expect(result).toBe(write);
        const failure = new Error("clipboard unavailable");
        const assertion = expect(result).rejects.toBe(failure);
        reject(failure);
        await assertion;
        expect(() => mocks.handlers.get(HangCopyChannel)!(null, 42)).toThrow("text expected");
    } finally {
        vi.useRealTimers();
    }
});
