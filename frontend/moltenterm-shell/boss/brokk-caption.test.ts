// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { captionSentences } from "./brokk-caption";

describe("the lines of his caption read as sentences (FR-BOSS-009, AC17, #2033)", () => {
    it("makes each of two lines a sentence", () => {
        expect(captionSentences(["Tout le monde a terminé", "Rien pour vous"])).toBe(
            "Tout le monde a terminé. Rien pour vous."
        );
        expect(captionSentences(["Everyone finished", "Nothing for you"])).toBe("Everyone finished. Nothing for you.");
    });

    it("leaves the punctuation a line already has", () => {
        expect(captionSentences(["Bien reçu !", "Rien pour vous"])).toBe("Bien reçu ! Rien pour vous.");
        expect(captionSentences(["Is it done?", "Yes."])).toBe("Is it done? Yes.");
        expect(captionSentences(["Wait…", "Nothing"])).toBe("Wait… Nothing.");
    });

    it("ends a line that closes on a bracket with a full stop too", () => {
        expect(captionSentences(["Olivia (waits)", "Nothing"])).toBe("Olivia (waits). Nothing.");
    });

    it("leaves a caption of one line as it is, with no full stop added", () => {
        expect(captionSentences(["Nothing to handle"])).toBe("Nothing to handle");
        expect(captionSentences(["Nothing to handle", ""])).toBe("Nothing to handle");
        expect(captionSentences(["", "  ", null])).toBe("");
    });

    it("keeps the order and drops the empty lines between", () => {
        expect(captionSentences(["A", "", "B", "C"])).toBe("A. B. C.");
    });
});
