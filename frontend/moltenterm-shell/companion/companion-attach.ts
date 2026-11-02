// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The companion's next actions when it has nothing to show (FR-SHELL-053, DS-SHELL-094): attach it to a terminal of
// its tab, or start the project's coding agent (its agent@ preset, #845) and follow it. The agent is typed into the
// companion's own terminal only while that shell waits at its prompt; anything else gets a new terminal beside the
// companion, so a running program never receives the command as input.

import { ClientModel } from "@/app/store/client-model";
import { atoms, createBlockSplitHorizontally } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CodingAgentChoice, codingAgentName, fetchCodingAgent } from "../coding-agent/coding-agent";
import { t } from "../i18n/i18n";
import { AgentBlockDef, typeCommandWhenReady } from "../palette/palette-actions";
import { readAgentPresets } from "../palette/palette-sources";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { CompanionTargetMetaKey } from "./companion-model";

export type AttachCandidate = { blockId: string; label: string; current: boolean };

export type CompanionAgent = { name: string; command: string };

// What the companion remembers of the agents it started (client meta): the last one, so it comes first in the menu, and
// the commands the developer typed under "Other command…".
export const CompanionAgentMetaKey = "moltenterm:companionagent";
const MaxRememberedCommands = 8;

export type CompanionAgentMemory = { last?: string; commands?: string[] };

export type StartOption = { key: string; agent: CompanionAgent; custom: boolean };

// What the start button does (#1460): it never presumes a provider. The agent the developer chose (project or default),
// or the only one found on this computer, starts directly; otherwise the developer picks among the ones found and the
// commands typed before, or names another command.
export type CompanionStartPlan =
    | { kind: "direct"; agent: CompanionAgent; key: string; explicit: boolean }
    | { kind: "menu"; options: StartOption[] };

export function customKey(command: string): string {
    return `cmd:${command}`;
}

// A command typed by the developer: one line, no control character, so what is typed into the terminal is one command.
export function cleanCustomCommand(text: string): string {
    const command = (text ?? "").trim();
    // eslint-disable-next-line no-control-regex
    return command === "" || /[\u0000-\u001f\u007f]/.test(command) ? "" : command;
}

export function readCompanionAgentMemory(client: Client): CompanionAgentMemory {
    const value = client?.meta?.[CompanionAgentMetaKey];
    if (value == null || typeof value !== "object") {
        return {};
    }
    const memory = value as CompanionAgentMemory;
    return {
        last: typeof memory.last === "string" ? memory.last : undefined,
        commands: Array.isArray(memory.commands)
            ? memory.commands.filter((c) => typeof c === "string" && cleanCustomCommand(c) !== "")
            : [],
    };
}

export function nextCompanionAgentMemory(memory: CompanionAgentMemory, key: string): CompanionAgentMemory {
    const commands = [...(memory?.commands ?? [])];
    if (key.startsWith("cmd:")) {
        const command = key.slice(4);
        commands.splice(0, commands.length, command, ...commands.filter((c) => c !== command));
    }
    return { last: key, commands: commands.slice(0, MaxRememberedCommands) };
}

export function companionStartPlan(
    choice: CodingAgentChoice,
    presets: { [key: string]: MetaType },
    memory: CompanionAgentMemory
): CompanionStartPlan {
    const explicit = choice?.source != null && choice.source !== "order" ? (choice.chosen ?? choice.agent) : "";
    if (explicit) {
        return {
            kind: "direct",
            agent: companionAgent(presets, explicit, choice.known),
            key: explicit,
            explicit: true,
        };
    }
    const found: StartOption[] = (choice?.known ?? [])
        .filter((a) => a.installed)
        .map((a) => ({ key: a.id, agent: companionAgent(presets, a.id, choice.known), custom: false }));
    const typed: StartOption[] = (memory?.commands ?? []).map((command) => ({
        key: customKey(command),
        agent: { name: command, command },
        custom: true,
    }));
    if (found.length === 1 && typed.length === 0) {
        return { kind: "direct", agent: found[0].agent, key: found[0].key, explicit: false };
    }
    const options = [...found, ...typed];
    const last = options.findIndex((o) => o.key === memory?.last);
    if (last > 0) {
        options.unshift(...options.splice(last, 1));
    }
    return { kind: "menu", options };
}

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
            label: t("companion.attachTerminal", { n: rtn.length + 1, where }),
            current: block.oid === current,
        });
    }
    return rtn;
}

// The preset of a coding agent as configured (its command can be changed or hidden by the user); the agent's own name
// and program otherwise, as the adapter registry gave them. No agent: none, the companion never presumes one (#1460).
export function companionAgent(
    presets: { [key: string]: MetaType },
    agentId?: string,
    known?: { id: string; name: string; command?: string }[]
): CompanionAgent {
    const id = agentId;
    if (!id) {
        return null;
    }
    const entry = (known ?? []).find((a) => a.id === id);
    const fallback = { name: entry?.name || codingAgentName(id), command: entry?.command || id };
    const preset = readAgentPresets(presets ?? {}).find((p) => p.id === id);
    if (preset == null) {
        return fallback;
    }
    return { name: preset.name || fallback.name, command: preset.command };
}

// The developer's chosen agent (#845) must still be installed when it starts: a chosen agent that is not stops the start
// with its reason instead of starting another one.
async function checkChosenAgent(): Promise<void> {
    let choice: CodingAgentChoice;
    try {
        choice = await fetchCodingAgent(readWorkspaceProject(globalStore.get(atoms.workspace)).dir);
    } catch {
        return;
    }
    if (choice?.missing) {
        throw new Error(t("codingAgent.missing", { agent: choice.chosenname || codingAgentName(choice.chosen) }));
    }
}

async function rememberCompanionAgent(key: string): Promise<void> {
    const clientModel = ClientModel.getInstance();
    if (clientModel.clientId == null || !key) {
        return;
    }
    const client = globalStore.get(clientModel.clientAtom);
    const next = nextCompanionAgentMemory(readCompanionAgentMemory(client), key);
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("client", clientModel.clientId),
            meta: { [CompanionAgentMetaKey]: next } as MetaType,
        });
    } catch {
        // The order of the menu is a convenience; the agent has started.
    }
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
export async function startCompanionAgent(
    companionId: string,
    target: string,
    agent: CompanionAgent,
    key: string,
    explicit: boolean
): Promise<string> {
    if (explicit) {
        await checkChosenAgent();
    }
    if (target && shellAtPrompt(await readRtInfo(target))) {
        if (await typeCommandWhenReady(target, agent.command)) {
            await rememberCompanionAgent(key);
            return target;
        }
    }
    // The companion docks on the right of its terminal: the new one opens on its left.
    const blockId = await createBlockSplitHorizontally(AgentBlockDef, companionId, "before");
    await attachCompanion(companionId, blockId);
    if (!(await typeCommandWhenReady(blockId, agent.command))) {
        throw new Error(`The new terminal did not start, ${agent.name} was not started.`);
    }
    await rememberCompanionAgent(key);
    return blockId;
}
