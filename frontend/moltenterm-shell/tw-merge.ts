// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's default theme: it would read `text-11` as a text colour and drop it next to
// `text-secondary`, and let `rounded-6` survive next to `rounded-4`. The design tokens (tokens.css) are declared to it
// here; cn() in frontend/util/util.ts merges with this instance (MOLTENTERM-PATCH #398).
export const twMerge = extendTailwindMerge({
    extend: {
        theme: {
            text: ["11", "12", "13", "15", "20", "32", "icon-14", "icon-16", "icon-20"],
            radius: ["4", "6", "10"],
            shadow: ["e1", "e2", "e3"],
            ease: ["mt"],
            spacing: ["row", "row-lg"],
            color: ["surface-1", "surface-2", "surface-3", "danger", "info", "line", "line-strong"],
        },
    },
});
