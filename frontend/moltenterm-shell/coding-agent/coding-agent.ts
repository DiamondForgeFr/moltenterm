// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The coding agent MoltenTerm starts on its own (#845): the reviews' investigate, rebase, restart and batch merge, the
// assisted review and the release notes. One choice, per project with a global default, set in the options (command
// panel) of every panel that starts an agent; wavesrv resolves it for every flow (pkg/molten/agentchoice). The
// project's choice lives in the client meta by folder, like the line map's window; the default in the settings.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { CommandPanelModel } from "../command-panel/command-panel-store";
import { t } from "../i18n/i18n";

// must match pkg/molten/agentchoice
export const CodingAgentSettingKey = "moltenterm:codingagent";
export const CodingAgentsMetaKey = "moltenterm:codingagents";
const RouteId = "molten:agentchoice";
const GetCommand = "moltenagentchoice";
const GetTimeoutMs = 8000;

// The agents the flows can start, in the default order, before wavesrv says which are installed.
export const CodingAgentIds = ["claude", "codex"];

export type CodingAgent = { id: string; name: string; installed: boolean };

// must match Choice in pkg/molten/agentchoice/agentchoice.go
export type CodingAgentChoice = {
    agent?: string;
    agentname?: string;
    source?: "run" | "project" | "global" | "order";
    chosen?: string;
    chosenname?: string;
    missing?: boolean;
    project?: string;
    global?: string;
    order?: string;
    agents: CodingAgent[];
};

export function codingAgentName(id: string): string {
    switch (id) {
        case "claude":
            return "Claude Code";
        case "codex":
            return "Codex";
    }
    return id ?? "";
}

export function fetchCodingAgent(dir: string, agent?: string): Promise<CodingAgentChoice> {
    return TabRpcClient.wshRpcCall(GetCommand, { dir, agent }, { route: RouteId, timeout: GetTimeoutMs });
}

// The client meta holds every project's choice and a write replaces it whole: a second choice made before the first
// write came back builds on the first.
let unconfirmed: Record<string, string> = null;

function storedChoices(): Record<string, string> {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const client = clientAtom != null ? globalStore.get(clientAtom) : null;
    const value = unconfirmed ?? client?.meta?.[CodingAgentsMetaKey];
    return value != null && typeof value === "object" ? (value as Record<string, string>) : {};
}

// The project's own choice, undefined when it follows the default.
export function rememberedProjectAgent(dir: string): string {
    const id = dir ? storedChoices()[dir] : null;
    return CodingAgentIds.includes(id) ? id : undefined;
}

// What This project sets and resets in the panels' options: no agent forgets the project's choice.
export function rememberProjectAgent(dir: string, agent: string): Promise<void> {
    const clientId = ClientModel.getInstance().clientId;
    if (!dir || clientId == null) {
        return Promise.resolve();
    }
    const next = { ...storedChoices() };
    if (agent) {
        next[dir] = agent;
    } else {
        delete next[dir];
    }
    unconfirmed = next;
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: makeORef("client", clientId),
        meta: { [CodingAgentsMetaKey]: next } as MetaType,
    }).finally(() => {
        if (unconfirmed === next) {
            unconfirmed = null;
        }
        CodingAgentModel.getInstance().refresh(dir);
    });
}

const StaleMs = 15000;

// What wavesrv answered for each folder: the installed agents and the resolution, read again when a panel's options
// open (an agent may have been installed since) and after every change.
export class CodingAgentModel {
    private static instance: CodingAgentModel = null;

    choicesAtom = atom({}) as PrimitiveAtom<Record<string, { choice: CodingAgentChoice; at: number }>>;
    loading = new Set<string>();

    private constructor() {}

    static getInstance(): CodingAgentModel {
        if (CodingAgentModel.instance == null) {
            CodingAgentModel.instance = new CodingAgentModel();
        }
        return CodingAgentModel.instance;
    }

    // choiceOf answers what is known and reads it again when it is old; the panel shows the answer when it lands.
    choiceOf(dir: string): CodingAgentChoice {
        const entry = globalStore.get(this.choicesAtom)[dir ?? ""];
        if (entry == null || Date.now() - entry.at > StaleMs) {
            this.refresh(dir);
        }
        return entry?.choice ?? null;
    }

    refresh(dir: string) {
        const key = dir ?? "";
        if (this.loading.has(key)) {
            return;
        }
        this.loading.add(key);
        fireAndForget(async () => {
            try {
                const choice = await fetchCodingAgent(key);
                globalStore.set(this.choicesAtom, {
                    ...globalStore.get(this.choicesAtom),
                    [key]: { choice, at: Date.now() },
                });
                CommandPanelModel.getInstance().sourcesChanged();
            } catch (e) {
                console.log("[coding-agent] the choice could not be read", e);
            } finally {
                this.loading.delete(key);
            }
        });
    }
}

// The item's secondary text: the agent missing, else what no choice gives.
export function codingAgentDetail(choice: CodingAgentChoice): string {
    if (choice == null) {
        return undefined;
    }
    if (choice.missing) {
        return t("codingAgent.missing", { agent: choice.chosenname || codingAgentName(choice.chosen) });
    }
    if (choice.source === "order") {
        return choice.order
            ? t("codingAgent.automatic", { agent: codingAgentName(choice.order) })
            : t("codingAgent.noneInstalled");
    }
    return undefined;
}

export function codingAgentOptions(choice: CodingAgentChoice) {
    const agents: CodingAgent[] =
        choice?.agents ?? CodingAgentIds.map((id) => ({ id, name: codingAgentName(id), installed: true }));
    return agents.map((a) => ({
        id: `codingagent:${a.id}`,
        label: a.name,
        value: a.id,
        disabled: !a.installed,
        detail: a.installed ? undefined : t("codingAgent.notInstalled"),
    }));
}
