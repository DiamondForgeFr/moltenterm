// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { announcesImplicitSwitch, ExplicitSwitchWindowMs } from "./project-follow";

describe("the toast of a project made current by showing a view or an agent (#1760)", () => {
    const now = 1_000_000;

    it("says it when the project changed and the developer did not just choose it", () => {
        expect(announcesImplicitSwitch("p1", "p2", now - 60_000, now)).toBe(true);
        expect(announcesImplicitSwitch("p1", "p2", 0, now)).toBe(true);
    });

    it("stays quiet after the developer's own switch, which has its own toast", () => {
        expect(announcesImplicitSwitch("p1", "p2", now - 500, now)).toBe(false);
        expect(announcesImplicitSwitch("p1", "p2", now - ExplicitSwitchWindowMs - 1, now)).toBe(true);
    });

    it("stays quiet when nothing changed or a workspace has no project", () => {
        expect(announcesImplicitSwitch("p1", "p1", 0, now)).toBe(false);
        expect(announcesImplicitSwitch("", "p1", 0, now)).toBe(false);
        expect(announcesImplicitSwitch("p1", "", 0, now)).toBe(false);
    });
});
