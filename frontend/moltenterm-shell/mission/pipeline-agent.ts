// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Ask for help" in the pipeline setup's tab (FR-MC-038, #1150): the tab opens on the setup panel alone; asking opens
// the agent's terminal on its left (agent left, graphics right), starts the project's coding agent there when none
// runs, and hands it the screen's context. A terminal the tab already has is reused, and so is its agent. Nothing
// starts without the developer's click (#758).
//
// The agent is the one the generic choice resolves for the project (pkg/molten/agentchoice, any CLI), run through its
// agent@ preset as the companion does, typed only while the terminal's shell waits at its prompt. The context goes
// MoltenTerm's own request way (wavesrv, agenthandoff #1143): a brief in MoltenTerm's data folder and a short prompt
// typed when the agent's prompt is idle, whatever its CLI. The brief names the pipeline writing guide.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutTreeSplitHorizontalAction } from "@/layout/lib/types";
import { CodingAgentChoice, codingAgentName, fetchCodingAgent } from "../coding-agent/coding-agent";
import { companionAgent, CompanionAgent, shellAtPrompt, tabBlocks } from "../companion/companion-attach";
import { typeCommandWhenReady } from "../palette/palette-actions";
import { MissionRouteId } from "./mission-client";
import { PipelineTermMetaKey } from "./pipeline-tab-model";

// must match pkg/molten/mission/pipelineask.go
export const PipelineAskCommand = "moltenmissionpipelineask";
// The terminal's share of the tab's width beside the setup panel's 10 (pkg/molten/mission/pipelinetab.go).
export const PipelineTermNodeSize = 6;
// wavesrv waits up to 45 s for an agent just started (pipelineask.go), plus a margin.
const AskTimeoutMs = 60000;

// ready: the agent to start; none: no supported agent is installed; missing: the chosen one is not installed.
export type PipelineAgent =
    | { state: "ready"; id: string; agent: CompanionAgent }
    | { state: "none" }
    | { state: "missing"; name: string };

// sent: the context reached the agent (or waits for its prompt); busy: the terminal runs something else.
export type PipelineAskResult = "sent" | "busy" | "none" | "missing" | "failed";

export type PipelineAskRequest = {
    // The screen's context in plain text: the step, the question, what was said.
    context: string;
};

type AskAnswer = { status: "sent" | "noagent"; delivery?: string; to?: string };

export function pipelineAgentOf(choice: CodingAgentChoice, presets: { [key: string]: MetaType }): PipelineAgent {
    if (choice?.missing) {
        return { state: "missing", name: choice.chosenname || codingAgentName(choice.chosen) };
    }
    if (!choice?.agent) {
        return { state: "none" };
    }
    return { state: "ready", id: choice.agent, agent: companionAgent(presets, choice.agent) };
}

// The tab's terminal for the project: the one it opened, else any terminal of the tab in that folder.
export function pipelineTerminalOf(blocks: Block[], dir: string): string {
    const terms = (blocks ?? []).filter((b) => b?.meta?.view === "term");
    const own = terms.find((b) => b.meta[PipelineTermMetaKey] === dir);
    if (own != null) {
        return own.oid;
    }
    return terms.find((b) => b.meta["cmd:cwd"] === dir)?.oid ?? "";
}

// A shell without MoltenTerm's integration (sh, a custom shell) never reports its prompt: the developer's click on a
// terminal where no agent runs is then all there is to go on.
export function atPromptOf(rtInfo: ObjRTInfo): boolean {
    if (!rtInfo?.["shell:integration"]) {
        return true;
    }
    return shellAtPrompt(rtInfo);
}

export type PipelineAgentDeps = {
    choice: (dir: string) => Promise<CodingAgentChoice>;
    presets: () => { [key: string]: MetaType };
    blocks: () => Block[];
    atPrompt: (blockId: string) => Promise<boolean>;
    newTerminal: (dir: string, panelBlockId: string) => Promise<string>;
    type: (blockId: string, command: string) => Promise<boolean>;
    ask: (data: Record<string, unknown>) => Promise<AskAnswer>;
};

async function readAtPrompt(blockId: string): Promise<boolean> {
    try {
        return atPromptOf(await RpcApi.GetRTInfoCommand(TabRpcClient, { oref: makeORef("block", blockId) }));
    } catch {
        return false;
    }
}

// The agent's terminal, on the left of the setup panel, in the project's folder.
async function openTerminalLeft(dir: string, panelBlockId: string): Promise<string> {
    const layoutModel = getLayoutModelForStaticTab();
    const blockId = await ObjectService.CreateBlock(
        { meta: { view: "term", controller: "shell", "cmd:cwd": dir, [PipelineTermMetaKey]: dir } as MetaType },
        { termsize: { rows: 25, cols: 80 } }
    );
    const target = layoutModel.getNodeByBlockId(panelBlockId)?.id;
    if (target == null) {
        throw new Error("the setup panel is not in this tab's layout");
    }
    const split: LayoutTreeSplitHorizontalAction = {
        type: LayoutTreeActionType.SplitHorizontal,
        targetNodeId: target,
        newNode: newLayoutNode(undefined, PipelineTermNodeSize, undefined, { blockId }),
        position: "before",
        focused: true,
    };
    layoutModel.treeReducer(split);
    return blockId;
}

const DefaultDeps: PipelineAgentDeps = {
    choice: (dir) => fetchCodingAgent(dir),
    presets: () => globalStore.get(atoms.fullConfigAtom)?.presets,
    blocks: tabBlocks,
    atPrompt: readAtPrompt,
    newTerminal: openTerminalLeft,
    type: typeCommandWhenReady,
    ask: (data) => TabRpcClient.wshRpcCall(PipelineAskCommand, data, { route: MissionRouteId, timeout: AskTimeoutMs }),
};

// Asks the tab's agent for help with the screen's context: opens or reuses the terminal on the left, starts the agent
// when none runs there, then hands it the context. panelBlockId: the setup panel.
export async function askPipelineAgent(
    dir: string,
    project: string,
    panelBlockId: string,
    req: PipelineAskRequest,
    deps: PipelineAgentDeps = DefaultDeps
): Promise<PipelineAskResult> {
    const data = { dir, project, context: req?.context ?? "" };
    let terminal = pipelineTerminalOf(deps.blocks(), dir);
    try {
        if (terminal) {
            const answer = await deps.ask({ ...data, blockid: terminal });
            if (answer?.status === "sent") {
                return "sent";
            }
        }
        const agent = pipelineAgentOf(await deps.choice(dir), deps.presets());
        if (agent.state !== "ready") {
            return agent.state;
        }
        if (terminal && !(await deps.atPrompt(terminal))) {
            return "busy";
        }
        if (!terminal) {
            terminal = await deps.newTerminal(dir, panelBlockId);
        }
        if (!(await deps.type(terminal, agent.agent.command))) {
            return "failed";
        }
        const answer = await deps.ask({ ...data, blockid: terminal, wait: true });
        return answer?.status === "sent" ? "sent" : "failed";
    } catch {
        return "failed";
    }
}
