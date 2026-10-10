// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the command panel knows about the panel it opens for (DS-SHELL-086): its view, meta, view model, the agent
// running in it and the capabilities providers match on.

import { getBlockComponentModel, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { isLocalConnName } from "@/util/util";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { PanelContext } from "./panel-types";

// The panel kinds' names, and their plural for the kind scope ("All terminals").
const PanelKinds: Record<string, { name: string; plural: string }> = {
    term: { name: "Terminal", plural: "terminals" },
    preview: { name: "Preview", plural: "previews" },
    web: { name: "Web", plural: "web panels" },
    help: { name: "Help", plural: "help panels" },
    sysinfo: { name: "System info", plural: "system info panels" },
    cpuplot: { name: "System info", plural: "system info panels" },
    processviewer: { name: "Processes", plural: "process panels" },
    tsunami: { name: "App", plural: "apps" },
    "molten-browser": { name: "Browser", plural: "browser panels" },
    "molten-companion": { name: "Companion", plural: "companions" },
    "molten-linemap": { name: "Line map", plural: "line maps" },
    "molten-cicd": { name: "CI/CD", plural: "CI/CD panels" },
    "molten-project": { name: "Project", plural: "project panels" },
    "molten-timeline": { name: "Project", plural: "project panels" },
    "molten-sessions": { name: "Sessions", plural: "sessions panels" },
};

export function panelKind(view: string): { name: string; plural: string } {
    return PanelKinds[view] ?? { name: view || "Panel", plural: "panels of this kind" };
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
        panelName: PanelKinds[view]?.name ?? viewModelName(viewModel) ?? kind.name,
    };
}
