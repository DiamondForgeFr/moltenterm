// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A line of Brokk's scene (brokk-scene.ts) in the language of the app: the source's own text, or a key with its count
// and variables. The language follows the app, so a line is read where it is shown, never kept.

import { useT, useTCount } from "../i18n/i18n";
import type { CaptionLine } from "./brokk-scene";

// The lines of one caption read as one line (the one under his square, FR-BOSS-009, AC17): when there are two or more,
// each is a sentence, so "Everyone finished" and "Nothing for you" read "Everyone finished. Nothing for you." and not
// "Everyone finished Nothing for you". A caption of one line is left as it is.
export function captionSentences(lines: string[]): string {
    const parts = lines.map((line) => (line ?? "").trim()).filter((line) => line !== "");
    if (parts.length < 2) {
        return parts[0] ?? "";
    }
    return parts.map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`)).join(" ");
}

export function useCaptionText(): (line: CaptionLine) => string {
    const t = useT();
    const tCount = useTCount();
    return (line) => {
        if (line.text != null) {
            return line.text;
        }
        return line.count != null ? tCount(line.key, line.count, line.vars) : t(line.key, line.vars);
    };
}
