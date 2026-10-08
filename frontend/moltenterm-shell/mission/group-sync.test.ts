// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const gestures = vi.hoisted(() => new Map<string, (args: Record<string, any>) => Promise<any>>());
vi.mock("../notifications-store", () => ({
    UnknownGestureError: "This action is not available in this version.",
    notificationGesture: (name: string) => gestures.get(name) ?? null,
}));

import { DependencySyncGesture, startDependencySync } from "./group-sync";

describe("the group strip's Sync", () => {
    beforeEach(() => gestures.clear());

    it("answers like the notification center while no sync is registered", async () => {
        expect(await startDependencySync({ dir: "/r/site", project: "Notulia", index: 0 })).toEqual({
            ok: false,
            error: "This action is not available in this version.",
        });
    });

    it("starts the notification's Sync action with the same arguments", async () => {
        const gesture = vi.fn(async () => ({ ok: true }));
        gestures.set(DependencySyncGesture, gesture);
        expect(await startDependencySync({ dir: "/r/site", project: "Notulia", index: 1 })).toEqual({ ok: true });
        expect(gesture).toHaveBeenCalledWith({ dir: "/r/site", project: "Notulia", index: 1 });
    });

    it("reports a failure instead of throwing", async () => {
        gestures.set(DependencySyncGesture, async () => {
            throw new Error("busy");
        });
        expect(await startDependencySync({ dir: "/r/site", project: "Notulia", index: 0 })).toEqual({
            ok: false,
            error: "busy",
        });
    });
});
