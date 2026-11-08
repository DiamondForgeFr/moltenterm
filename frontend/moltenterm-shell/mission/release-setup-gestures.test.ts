// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({ setupPrReady: vi.fn() }));
vi.mock("../open-web-link", () => ({ openWebLink: vi.fn(async () => true) }));
vi.mock("../notifications-store", () => ({ registerNotificationGesture: vi.fn(() => () => {}) }));

import { openWebLink } from "../open-web-link";
import { setupPrReady } from "./release-setup-client";
import { setupPrOpenGesture, setupPrReadyGesture } from "./release-setup-gestures";

const url = "https://github.com/o/r/pull/1787";

// The notification's actions once the setup's draft has its checks done (#1788).
describe("the release setup's draft notification", () => {
    beforeEach(() => {
        vi.mocked(setupPrReady).mockReset();
        vi.mocked(openWebLink).mockClear();
    });

    it("marks the pull request ready on the click, and resolves the notification", async () => {
        vi.mocked(setupPrReady).mockResolvedValue({ ready: true });
        expect(await setupPrReadyGesture({ dir: "/p", url })).toEqual({ ok: true, resolve: true });
        expect(setupPrReady).toHaveBeenCalledWith("/p", url);
    });

    it("says why when gh refuses, and keeps the notification", async () => {
        vi.mocked(setupPrReady).mockRejectedValue(new Error("gh: HTTP 403"));
        const result = await setupPrReadyGesture({ dir: "/p", url });
        expect(result.ok).toBe(false);
        expect(result.resolve).toBeUndefined();
        expect(result.error).toContain("403");
    });

    it("refuses an action without its pull request", async () => {
        expect((await setupPrReadyGesture({ url })).ok).toBe(false);
        expect((await setupPrOpenGesture({})).ok).toBe(false);
        expect(setupPrReady).not.toHaveBeenCalled();
    });

    it("opens the pull request", async () => {
        expect(await setupPrOpenGesture({ url })).toEqual({ ok: true });
        expect(openWebLink).toHaveBeenCalledWith(url);
    });
});
