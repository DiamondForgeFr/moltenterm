// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { shownName } from "./view-pins-store";

vi.mock("../tab-identity-ui", () => ({
    viewDisplayName: (tab: Tab) => (tab?.oid === "t2" ? "Files · roman 2" : ""),
}));

describe("the name the pin toasts say (#1669)", () => {
    it("is the view's sidebar name, never Wave's generic T<n>", () => {
        expect(shownName({ oid: "t2", name: "T2" } as Tab)).toBe("Files · roman 2");
    });
});
