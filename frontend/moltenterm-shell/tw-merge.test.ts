// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { describe, expect, it } from "vitest";

describe("cn knows the design tokens (FR-SHELL-044)", () => {
    it("keeps a token size next to a text colour", () => {
        expect(cn("text-11 text-secondary")).toBe("text-11 text-secondary");
        expect(cn("text-icon-16 text-muted")).toBe("text-icon-16 text-muted");
    });

    it("lets a later size, radius or shadow token win", () => {
        expect(cn("text-12", "text-13")).toBe("text-13");
        expect(cn("text-xs", "text-12")).toBe("text-12");
        expect(cn("rounded-4", "rounded-6")).toBe("rounded-6");
        expect(cn("shadow-e1", "shadow-e3")).toBe("shadow-e3");
    });

    it("treats the surface and danger tokens as colours", () => {
        expect(cn("bg-surface-2", "bg-hover")).toBe("bg-hover");
        expect(cn("text-danger", "text-error")).toBe("text-error");
        expect(cn("text-12 text-danger")).toBe("text-12 text-danger");
    });
});
