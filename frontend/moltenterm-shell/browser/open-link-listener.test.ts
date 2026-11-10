// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({
    openLink: vi.fn(async (_url: string) => {}),
    listener: null as (url: string) => void,
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({
        onMoltentermOpenLink: (callback: (url: string) => void) => {
            Mocks.listener = callback;
        },
    }),
    openLink: Mocks.openLink,
}));

import { listenOpenLink } from "./open-link-listener";

describe("web pages the interface opened by itself (#2176)", () => {
    it("open like an interface link, once listening, web pages only", async () => {
        listenOpenLink();
        listenOpenLink();
        expect(Mocks.listener).not.toBeNull();
        Mocks.listener("https://example.com/docs");
        Mocks.listener("HTTP://localhost:8123/callback");
        Mocks.listener("file:///etc/passwd");
        Mocks.listener("javascript:alert(1)");
        Mocks.listener(null);
        await Promise.resolve();
        expect(Mocks.openLink.mock.calls).toEqual([["https://example.com/docs"], ["HTTP://localhost:8123/callback"]]);
    });
});
