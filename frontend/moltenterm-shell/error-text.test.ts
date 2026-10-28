// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The fill colour is valid for these icon-only usages. Error prose/statuses need a readable text token.
const IconUses = [
    "mission/branch-cleanup.tsx|<i className=\"fa fa-solid fa-trash-can w-3.5 text-11 text-error\" />",
    "mission/ci-icon.tsx|failure: \"fa-xmark text-error\",",
    "mission/release-run-panel.tsx|failed: \"border-error/60 bg-error/10 text-error\",",
    "mission/runs-view.tsx|failed: \"border-error/60 bg-error/10 text-error\",",
    "review/review-answers-view.tsx|className=\"cursor-pointer px-1 text-muted hover:text-error\"",
    "review/review-stepper-view.tsx|failed: \"border-error/60 bg-error/10 text-error\",",
    "sessions/sessions-dialogs.tsx|failed: \"text-error\",",
    "status-bar-model.ts|failure: \"fa-circle-xmark text-error\",",
    "toast-model.ts|error: { tone: \"error\", label: \"notif.tone.error\", colorClass: \"text-error\", icon: \"circle-exclamation\" },",
    "workspace-edit-sheet.tsx|<i className=\"fa fa-solid fa-circle-exclamation mr-1 text-error\" aria-hidden />",
];
function errorFillUses(folder: string): string[] {
    const base = join(process.cwd(), folder);
    const uses: string[] = [];
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (/\.tsx?$/.test(file) && !file.includes(".test.")) {
                for (const line of readFileSync(file, "utf8").split("\n")) {
                    if (line.includes("text-error")) uses.push(`${relative(base, file).split("\\").join("/")}|${line.trim()}`);
                }
            }
        }
    };
    visit(base);
    return uses.sort();
}

describe("error text semantics", () => {
    it("reserves the error fill utility for reviewed icon-only uses", () => {
        expect(errorFillUses("frontend/moltenterm-shell")).toEqual(IconUses.slice().sort());
    });

    it("keeps onboarding error prose on the readable danger text token (#975)", () => {
        expect(errorFillUses("frontend/moltenterm-onboarding")).toEqual([]);
    });
});
