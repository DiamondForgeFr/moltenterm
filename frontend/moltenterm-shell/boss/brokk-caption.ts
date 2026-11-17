// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A line of a visit (brokk-visit-line.ts) in the language of the app: the source's own text, or a key with its count and
// variables. The language follows the app, so a line is read where it is shown, never kept.

import { useT, useTCount } from "../i18n/i18n";
import type { CaptionLine } from "./brokk-scene";

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
