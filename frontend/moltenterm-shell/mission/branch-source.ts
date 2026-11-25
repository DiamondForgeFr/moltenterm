// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where a panel read the trunk's name (#2556, FR-MC-022): the project settings or SaaSFoundry when they declare it,
// else git alone. The collector sends the source as molten.BranchFrom… (pkg/molten/branches.go).

import { t } from "../i18n/i18n";
import { MissionGit } from "./mission-model";

// must match the BranchFrom… constants in pkg/molten/branches.go
const SourceKeys: Record<string, string> = {
    ".molten/project.json branches": "settings",
    ".saasfoundry.json workflow.workingBranch": "saasfoundry",
    ".saasfoundry.json workflow.releaseBranch": "saasfoundry",
    ".saasfoundry.json mainBranch": "saasfoundry",
    "origin/HEAD": "originHead",
    "git branch": "repository",
    "the branch checked out": "checkout",
    "the default": "default",
};

export function branchSourceKey(from: string): string {
    const key = SourceKeys[from ?? ""];
    return key ? `mc.branchFrom.${key}` : null;
}

// The source in the interface language; empty when unknown.
export function branchSourceText(from: string): string {
    const key = branchSourceKey(from);
    return key ? t(key) : "";
}

// The branch a panel's header names and where its name came from: never a dangling "·" when git named no trunk.
export function trunkRead(git: Pick<MissionGit, "trunk" | "trunkfrom">): {
    trunk: string;
    from: string;
    title: string;
} {
    if (git == null) {
        return null;
    }
    if (!git.trunk) {
        return { trunk: t("mc.frame.noTrunk"), from: "", title: t("mc.frame.noTrunkTitle") };
    }
    const from = branchSourceText(git.trunkfrom);
    return {
        trunk: git.trunk,
        from: from ? t("mc.frame.trunkFrom", { from }) : "",
        title: from ? t("mc.frame.trunkTitle", { trunk: git.trunk, from }) : git.trunk,
    };
}
