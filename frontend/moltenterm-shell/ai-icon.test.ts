// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AiIcon, terminalIcon } from "./ai-icon";

describe("terminal icon (#1257)", () => {
    it("is the AI icon of the AI panel while an agent runs, the terminal glyph otherwise", () => {
        expect(AiIcon).toBe("sparkles");
        expect(terminalIcon(true)).toBe("sparkles");
        expect(terminalIcon(false)).toBe("terminal");
    });
});
