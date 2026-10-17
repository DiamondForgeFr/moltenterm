// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent option (#845) of every panel that starts a coding agent: Reviews (investigate, rebase, restart, batch
// merge), the Review tab (the assisted review), the Project view (the release notes) and the companion (Start the
// agent here). One value per project with a
// global default, so a change in one panel shows in all of them.

import { atoms, globalStore } from "@/app/store/global";
import {
    codingAgentDetail,
    CodingAgentModel,
    codingAgentOptions,
    CodingAgentSettingKey,
    rememberedProjectAgent,
    rememberProjectAgent,
} from "../../coding-agent/coding-agent";
import { t } from "../../i18n/i18n";
import { ReviewPrMetaKey } from "../../review/review-client";
import { readWorkspaceProject } from "../../workspace-project";
import { readSettings, writeSettings } from "../bindings";
import { CommandProvider, PanelContext, PanelItem, PanelSection, ScopeBinding } from "../panel-types";

// The panels that start an agent on their own.
export const CodingAgentViews = new Set([
    "molten-reviews",
    "molten-review",
    "molten-review-ai",
    "molten-project",
    "molten-timeline",
    "molten-companion",
]);

// The project a panel works on: the Review tab's PR's, else the workspace's.
export function codingAgentDir(ctx: PanelContext): string {
    const pr = ctx.meta?.[ReviewPrMetaKey as keyof MetaType] as { dir?: string };
    if (typeof pr?.dir === "string" && pr.dir) {
        return pr.dir;
    }
    return readWorkspaceProject(globalStore.get(atoms.workspace)).dir;
}

function projectBinding(dir: string): ScopeBinding<string> {
    return {
        scope: "project",
        get: () => rememberedProjectAgent(dir),
        set: (agent) => rememberProjectAgent(dir, agent),
        clear: () => rememberProjectAgent(dir, undefined),
    };
}

function globalBinding(dir: string): ScopeBinding<string> {
    const write = async (agent: string) => {
        await writeSettings({ [CodingAgentSettingKey]: agent ?? null });
        CodingAgentModel.getInstance().refresh(dir);
    };
    return {
        scope: "global",
        get: () => {
            const v = readSettings(CodingAgentSettingKey);
            return typeof v === "string" && v ? v : undefined;
        },
        set: (agent) => write(agent),
        clear: () => write(undefined),
    };
}

export function codingAgentItem(dir: string): PanelItem {
    const choice = CodingAgentModel.getInstance().choiceOf(dir);
    return {
        id: "codingagent",
        type: "choice",
        label: t("codingAgent.label"),
        detail: codingAgentDetail(choice),
        icon: "robot",
        keywords: ["coding agent", "claude", "codex", "ai", "review", "release notes"],
        defaultValue: choice?.order || undefined,
        options: codingAgentOptions(choice),
        scopes: dir ? [projectBinding(dir), globalBinding(dir)] : [globalBinding(dir)],
    };
}

export function codingAgentSections(ctx: PanelContext): PanelSection[] {
    return [
        {
            id: "widget:codingagent",
            kind: "widget",
            title: t("codingAgent.section"),
            items: [codingAgentItem(codingAgentDir(ctx))],
        },
    ];
}

export const CodingAgentProvider: CommandProvider = {
    id: "molten-codingagent",
    kind: "widget",
    // After the panel's own options.
    order: 50,
    when: (ctx) => CodingAgentViews.has(ctx.view),
    sections: codingAgentSections,
};
