// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The companion's next actions when it has nothing to show (FR-SHELL-053, DS-SHELL-094): attach it to a terminal of
// its tab, or start Claude Code (the agent@claude preset) and follow it. The agent is typed into the companion's own
// terminal only while that shell waits at its prompt; anything else gets a new terminal beside the companion, so a
// running program never receives the command as input.

import { atoms, createBlockSplitHorizontally } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentBlockDef, typeCommandWhenReady } from "../palette/palette-actions";
import { readAgentPresets } from "../palette/palette-sources";
import { pathBaseName } from "../workspace-project";
import { CompanionTargetMetaKey } from "./companion-model";

export type AttachCandidate = { blockId: string; label: string; current: boolean };

export type CompanionAgent = { name: string; command: string };

export const DefaultCompanionAgent: CompanionAgent = { name: "Claude Code", command: "claude" };

// The terminals of the tab, numbered in the tab's order, named by their folder (and connection when remote).
export function attachCandidates(blocks: Block[], current: string): AttachCandidate[] {
    const rtn: AttachCandidate[] = [];
    for (const block of blocks ?? []) {
        if (block?.meta?.view !== "term") {
            continue;
        }
        const folder = pathBaseName((block.meta["cmd:cwd"] as string) ?? "") || "~";
        const conn = (block.meta.connection as string) ?? "";
        const where = conn && conn !== "local" ? `${folder} · ${conn}` : folder;
        rtn.push({
            blockId: block.oid,
            label: `Terminal ${rtn.length + 1} · ${where}`,
            current: block.oid === current,
        });
    }
    return rtn;
}

// The Claude Code preset as configured (its command can be changed or hidden by the user); the default otherwise.
export function companionAgent(presets: { [key: string]: MetaType }): CompanionAgent {
    const preset = readAgentPresets(presets ?? {}).find((p) => p.id === "claude");
    if (preset == null) {
        return DefaultCompanionAgent;
    }
    return { name: preset.name || DefaultCompanionAgent.name, command: preset.command };
}

// Shell integration says "ready" while the shell waits at its prompt, "running-command" otherwise.
export function shellAtPrompt(rtInfo: ObjRTInfo): boolean {
    return rtInfo?.["shell:state"] === "ready";
}

export function tabBlocks(): Block[] {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    return (tab?.blockids ?? [])
        .map((id) => globalStore.get(getWaveObjectAtom<Block>(makeORef("block", id))))
        .filter((b) => b != null);
}

export function tabAttachCandidates(current: string): AttachCandidate[] {
    return attachCandidates(tabBlocks(), current);
}

export async function attachCompanion(companionId: string, terminalId: string): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: makeORef("block", companionId),
        meta: { [CompanionTargetMetaKey]: terminalId } as MetaType,
    });
}

async function readRtInfo(blockId: string): Promise<ObjRTInfo> {
    try {
        return await RpcApi.GetRTInfoCommand(TabRpcClient, { oref: makeORef("block", blockId) });
    } catch {
        return null;
    }
}

// Starts the agent and attaches the companion to the terminal it runs in. Returns that terminal's block id.
export async function startCompanionAgent(companionId: string, target: string): Promise<string> {
    const agent = companionAgent(globalStore.get(atoms.fullConfigAtom)?.presets);
    if (target && shellAtPrompt(await readRtInfo(target))) {
        if (await typeCommandWhenReady(target, agent.command)) {
            return target;
        }
    }
    // The companion docks on the right of its terminal: the new one opens on its left.
    const blockId = await createBlockSplitHorizontally(AgentBlockDef, companionId, "before");
    await attachCompanion(companionId, blockId);
    if (!(await typeCommandWhenReady(blockId, agent.command))) {
        throw new Error(`The new terminal did not start, ${agent.name} was not started.`);
    }
    return blockId;
}
