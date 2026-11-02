// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAddressFocus, requestAddressFocus, takeAddressFocus } from "./address-focus";

beforeEach(() => {
    forgetAddressFocus("p1");
    forgetAddressFocus("p2");
});

describe("the address field of a page panel opened from a chooser (#1742)", () => {
    it("is handed to the panel's view model when it already exists", () => {
        const wantAddressFocus = vi.fn();
        requestAddressFocus("p1", { wantAddressFocus });
        expect(wantAddressFocus).toHaveBeenCalledTimes(1);
        expect(takeAddressFocus("p1")).toBe(false);
    });

    it("waits for the view model to be made when it does not exist yet", () => {
        requestAddressFocus("p1", null);
        requestAddressFocus("p2", undefined);
        expect(takeAddressFocus("p1")).toBe(true);
        expect(takeAddressFocus("p2")).toBe(true);
    });

    it("is taken once, by the panel that asked", () => {
        requestAddressFocus("p1", null);
        expect(takeAddressFocus("p2")).toBe(false);
        expect(takeAddressFocus("p1")).toBe(true);
        expect(takeAddressFocus("p1")).toBe(false);
    });

    it("asks nothing for a panel without an id", () => {
        requestAddressFocus("", null);
        requestAddressFocus(null, null);
        expect(takeAddressFocus("")).toBe(false);
    });
});
