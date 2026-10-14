// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the command panel knows about the panel it opens for (DS-SHELL-086): its view, meta, view model, the agent
// running in it and the capabilities providers match on.

import { getBlockComponentModel, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { isLocalConnName } from "@/util/util";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { t } from "../i18n/i18n";
import { PanelContext } from "./panel-types";

// The panel kinds' names, and their plural for the kind scope ("All terminals"): keys under cmdpanel.kinds.<kind>.
const PanelKinds: Record<string, string> = {
    term: "term",
    preview: "preview",
    web: "web",
    help: "help",
    sysinfo: "sysinfo",
    cpuplot: "sysinfo",
    processviewer: "processes",
    tsunami: "app",
    "molten-browser": "browser",
    "molten-companion": "companion",
    "molten-linemap": "linemap",
    "molten-cicd": "cicd",
    "molten-reviews": "reviews",
    "molten-project": "project",
    "molten-timeline": "project",
    "molten-sessions": "sessions",
};

export function panelKind(view: string): { name: string; plural: string } {
    const kind = PanelKinds[view];
    if (kind == null) {
        return { name: view || t("cmdpanel.kinds.other.name"), plural: t("cmdpanel.kinds.other.plural") };
    }
    return { name: t(`cmdpanel.kinds.${kind}.name`), plural: t(`cmdpanel.kinds.${kind}.plural`) };
}

// The capabilities a panel has (DS-SHELL-086): providers declare the ones they need.
export function panelCapabilities(input: {
    view: string;
    meta: MetaType;
    agent: AgentStateInfo;
    waveMenu: boolean;
}): Set<string> {
    const caps = new Set<string>();
    if (input.view) {
        caps.add(`view:${input.view}`);
    }
    if (input.view === "term") {
        caps.add("terminal");
    }
    if (input.view === "molten-browser") {
        caps.add("browser");
    }
    if (input.agent?.agent) {
        caps.add("agent");
        caps.add(`agent:${input.agent.agent}`);
    }
    const conn = input.meta?.connection;
    if (conn && !isLocalConnName(conn)) {
        caps.add("remote");
    }
    if (input.waveMenu) {
        caps.add("wave-menu");
    }
    return caps;
}

function viewModelName(viewModel: ViewModel): string {
    const name = (viewModel as any)?.viewName;
    try {
        const value = name != null && typeof name === "object" && "read" in name ? globalStore.get(name) : name;
        return typeof value === "string" && value.trim() !== "" ? value : null;
    } catch {
        return null;
    }
}

export function makePanelContext(blockId: string): PanelContext {
    const block = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId));
    if (block == null) {
        return null;
    }
    const view = block.meta?.view ?? "";
    const viewModel = getBlockComponentModel(blockId)?.viewModel ?? null;
    const agent = globalStore.get(AgentStates.getInstance().blockAtom(blockId)) ?? null;
    const kind = panelKind(view);
    return {
        blockId,
        view,
        meta: block.meta ?? {},
        viewModel,
        agent,
        capabilities: panelCapabilities({
            view,
            meta: block.meta,
            agent,
            waveMenu: typeof viewModel?.getSettingsMenuItems === "function",
        }),
        kindLabel: kind.plural,
        panelName: PanelKinds[view] != null ? kind.name : (viewModelName(viewModel) ?? kind.name),
    };
}
