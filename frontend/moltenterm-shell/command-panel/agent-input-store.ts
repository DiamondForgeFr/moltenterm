// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The calls of the Agent section to wavesrv's moltenagentinput (FR-SHELL-048) and the facts the section shows before
// a command (the permission mode Claude Code drew last). The facts are read when the panel collects its sections,
// at most once a second per terminal; the open panel collects again when they land.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    AgentInputCommand,
    AgentInputInfo,
    AgentInputInfoCommand,
    AgentInputRequest,
    AgentInputResult,
    AgentInputRoute,
} from "./agent-commands";
import { CommandPanelModel } from "./command-panel-store";

const InfoTimeoutMs = 3000;
// Shift+Tab steps wait for the agent to draw each mode (up to five presses).
const InputTimeoutMs = 20000;
const InfoFreshMs = 1000;

export class AgentInputs {
    private static instance: AgentInputs = null;

    infos = new Map<string, { info: AgentInputInfo; at: number }>();
    inflight = new Set<string>();

    private constructor() {}

    static getInstance(): AgentInputs {
        if (!AgentInputs.instance) {
            AgentInputs.instance = new AgentInputs();
        }
        return AgentInputs.instance;
    }

    // The last facts read, and a new read when they are older than a second.
    info(blockId: string): AgentInputInfo {
        const known = this.infos.get(blockId);
        if (known == null || Date.now() - known.at > InfoFreshMs) {
            this.refresh(blockId);
        }
        return known?.info ?? null;
    }

    refresh(blockId: string) {
        if (this.inflight.has(blockId)) {
            return;
        }
        this.inflight.add(blockId);
        TabRpcClient.wshRpcCall(
            AgentInputInfoCommand,
            { blockid: blockId },
            { route: AgentInputRoute, timeout: InfoTimeoutMs }
        )
            .then((info: AgentInputInfo) => {
                const before = JSON.stringify(this.infos.get(blockId)?.info ?? null);
                this.infos.set(blockId, { info, at: Date.now() });
                if (JSON.stringify(info ?? null) !== before) {
                    CommandPanelModel.getInstance().sourcesChanged();
                }
            })
            .catch((e) => console.error("agent input info", blockId, e))
            .finally(() => this.inflight.delete(blockId));
    }

    async send(req: AgentInputRequest): Promise<AgentInputResult> {
        try {
            const result: AgentInputResult = await TabRpcClient.wshRpcCall(AgentInputCommand, req, {
                route: AgentInputRoute,
                timeout: InputTimeoutMs,
            });
            if (result?.mode != null || req.action === "permissionmode") {
                this.infos.delete(req.blockid);
                this.refresh(req.blockid);
            }
            return result;
        } catch (e) {
            console.error("agent input", req.action, e);
            return null;
        }
    }
}
