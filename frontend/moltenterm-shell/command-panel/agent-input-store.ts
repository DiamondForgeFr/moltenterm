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
    inflight = new Map<string, Promise<void>>();

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

    // Fresh facts before the panel opens on one of the section's choices (the header's model and effort, #573), so it
    // opens with its options and the current one selected; never waits longer than a moment.
    async ready(blockId: string, maxWaitMs = 400): Promise<void> {
        const known = this.infos.get(blockId);
        if (known != null && Date.now() - known.at <= InfoFreshMs) {
            return;
        }
        await Promise.race([this.refresh(blockId), new Promise((resolve) => setTimeout(resolve, maxWaitMs))]);
    }

    refresh(blockId: string): Promise<void> {
        const pending = this.inflight.get(blockId);
        if (pending != null) {
            return pending;
        }
        const read = TabRpcClient.wshRpcCall(
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
        this.inflight.set(blockId, read);
        return read;
    }

    async send(req: AgentInputRequest): Promise<AgentInputResult> {
        try {
            const result: AgentInputResult = await TabRpcClient.wshRpcCall(AgentInputCommand, req, {
                route: AgentInputRoute,
                timeout: InputTimeoutMs,
            });
            if (
                result?.mode != null ||
                req.action === "permissionmode" ||
                req.action === "effort" ||
                req.action === "model"
            ) {
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
