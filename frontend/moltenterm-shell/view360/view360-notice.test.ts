// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideView360, normalizeView360Setting, view360Unchosen } from "./view360-decision";
import {
    resetView360Notice,
    shouldShowView360Notice,
    showView360Notice,
    View360NoticeState,
    View360NoticeToastId,
} from "./view360-notice";

const mocks = vi.hoisted(() => ({
    toasts: [] as any[],
    dismissed: [] as string[],
    setConfig: [] as any[],
}));

vi.mock("../toast-store", () => ({
    showToast: (input: any) => {
        mocks.toasts.push(input);
        return input.id;
    },
    dismissToast: (id: string) => mocks.dismissed.push(id),
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetConfigCommand: (_client: unknown, settings: unknown) => {
            mocks.setConfig.push(settings);
            return Promise.resolve();
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const overThreshold = { manual: null as boolean, autoOn: false, columnsOver: true, cannotFit: false, columnCount: 4 };

describe("360 view first-switch notice (FR-SHELL-066-AC10, #1654)", () => {
    beforeEach(() => {
        mocks.toasts.length = 0;
        mocks.dismissed.length = 0;
        mocks.setConfig.length = 0;
        resetView360Notice();
    });

    it("reads Keep the grid as a setting of its own, and unset as not chosen", () => {
        expect(normalizeView360Setting("grid")).toBe("grid");
        expect(normalizeView360Setting(undefined)).toBe("auto");
        expect(view360Unchosen(undefined)).toBe(true);
        expect(view360Unchosen("")).toBe(true);
        expect(view360Unchosen("auto")).toBe(false);
        expect(view360Unchosen("grid")).toBe(false);
    });

    it("keeps the grid beyond the threshold and under the readable-minimum rule", () => {
        expect(decideView360({ ...overThreshold, setting: "grid" })).toEqual({
            active: false,
            wanted: false,
            source: "setting",
        });
        expect(decideView360({ ...overThreshold, columnsOver: false, autoOn: true, setting: "grid" }).active).toBe(
            false
        );
        expect(decideView360({ ...overThreshold, setting: "auto" }).active).toBe(true);
    });

    it("still switches under Keep the grid when the columns cannot fit at all, and on demand", () => {
        expect(decideView360({ ...overThreshold, cannotFit: true, setting: "grid" })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
            reason: "fit",
        });
        expect(decideView360({ ...overThreshold, manual: true, setting: "grid" }).active).toBe(true);
    });

    it("announces only a switch to 360 view while the developer never chose, once per session", () => {
        expect(shouldShowView360Notice(undefined, true, false)).toBe(true);
        expect(shouldShowView360Notice(undefined, false, false)).toBe(false);
        expect(shouldShowView360Notice("auto", true, false)).toBe(false);
        expect(shouldShowView360Notice("grid", true, false)).toBe(false);
        expect(shouldShowView360Notice(undefined, true, true)).toBe(false);
        expect(showView360Notice(() => {})).toBe(true);
        expect(View360NoticeState.shown).toBe(true);
        expect(showView360Notice(() => {})).toBe(false);
        expect(mocks.toasts).toHaveLength(1);
    });

    it("is a toast that waits for an answer, Keep the grid first", () => {
        showView360Notice(() => {});
        const toast = mocks.toasts[0];
        expect(toast.id).toBe(View360NoticeToastId);
        expect(toast.stays).toBe(true);
        expect(toast.actions.map((a: any) => a.id)).toEqual(["grid", "auto"]);
        expect(toast.text().actionLabels).toEqual({ grid: "Keep the grid", auto: "Use 360" });
    });

    it.each([
        ["grid", 0],
        ["auto", 1],
    ])("stores the answer %s and closes the notice", async (choice, index) => {
        const chosen: string[] = [];
        showView360Notice((c) => chosen.push(c));
        await mocks.toasts[0].actions[index].run();
        expect(chosen).toEqual([choice]);
        expect(mocks.dismissed).toEqual([View360NoticeToastId]);
        expect(mocks.setConfig).toEqual([{ "moltenterm:view360": choice }]);
    });
});
