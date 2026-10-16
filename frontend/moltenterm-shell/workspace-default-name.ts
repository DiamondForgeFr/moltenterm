// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The names wavesrv gives a workspace the user has not named (pkg/wcore/wcore.go, pkg/wcore/workspace.go) are stored in
// English and shown in the interface language (#743), as the Project tab's name is (#741): the data carries no
// language, and a language change reaches every workspace at once. A name the user typed is shown as typed.

import type { I18nVars } from "./i18n/i18n-core";

type Translate = (key: string, vars?: I18nVars) => string;

// must match wcore.go's starter workspace and workspace.go's UpdateWorkspace default
export const StarterWorkspaceName = "Starter workspace";
const NewWorkspacePattern = /^New Workspace \(([^()]+)\)$/;

export type DefaultWorkspaceName = { kind: "starter" } | { kind: "new"; id: string };

export function defaultWorkspaceName(name: string): DefaultWorkspaceName {
    if (name === StarterWorkspaceName) {
        return { kind: "starter" };
    }
    const match = NewWorkspacePattern.exec(name ?? "");
    return match != null ? { kind: "new", id: match[1] } : null;
}

export function workspaceShownName(name: string, t: Translate): string {
    const found = defaultWorkspaceName(name);
    if (found == null) {
        return name;
    }
    if (found.kind === "starter") {
        return t("workspace.defaultName.starter");
    }
    return t("workspace.defaultName.new", { id: found.id });
}
