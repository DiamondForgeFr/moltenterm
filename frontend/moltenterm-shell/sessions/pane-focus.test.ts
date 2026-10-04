// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FocusFreshMs, freshFocusRequest, paneShowStep } from "./pane-focus-model";

describe("focus requests", () => {
    const now = 1_000_000;
    it("applies a fresh request and ignores a stale or malformed one", () => {
        expect(freshFocusRequest({ "molten:focusblock": { blockid: "b1", ts: now - 500 } }, now)).toBe("b1");
        expect(freshFocusRequest({ "molten:focusblock": { blockid: "b1", ts: now - FocusFreshMs } }, now)).toBe("b1");
        expect(
            freshFocusRequest({ "molten:focusblock": { blockid: "b1", ts: now - FocusFreshMs - 1 } }, now)
        ).toBeNull();
        expect(freshFocusRequest({ "molten:focusblock": { blockid: "", ts: now } }, now)).toBeNull();
        expect(freshFocusRequest({ "molten:focusblock": "b1" }, now)).toBeNull();
        expect(freshFocusRequest({}, now)).toBeNull();
        expect(freshFocusRequest(null, now)).toBeNull();
    });
});

describe("showing a pane", () => {
    const loc = { workspaceid: "ws1", tabid: "t1", blockid: "b1" };
    it("focuses in this tab, switches tab in this workspace, switches workspace otherwise", () => {
        expect(paneShowStep(loc, "ws1", "t1")).toBe("focus");
        expect(paneShowStep(loc, "ws1", "t2")).toBe("tab");
        expect(paneShowStep(loc, "ws2", "t9")).toBe("workspace");
    });
});
