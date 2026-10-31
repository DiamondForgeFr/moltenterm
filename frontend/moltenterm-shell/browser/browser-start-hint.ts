// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A folder without git gets no word about code or GitHub on the start page (#1643): the hint only names its README.
export function startPageHintKey(dir: string, repo: boolean): string {
    if (!dir) {
        return "browser.start.hintNoProject";
    }
    return repo ? "browser.start.hintProject" : "browser.start.hintFolder";
}
