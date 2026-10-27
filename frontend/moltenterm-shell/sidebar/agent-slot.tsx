// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// An agent slot (FR-SHELL-080): a view pinned everywhere opens in each workspace with its own agent, so the terminal
// that held an agent when the view was pinned opens empty, in the project's folder, and offers to start one. Nothing
// starts unasked; the line goes once an agent runs there.
//
// A view reopened from the library's put-away views (FR-SHELL-088) comes back with its agent: the terminal that held
// one types the command that resumes its session once, then forgets it.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { typeCommandWhenReady } from "../palette/palette-actions";
import { readResumeAgent, ResumeAgentMetaKey } from "../reopen/reopen-model";
import { AgentSlotMetaKey } from "./view-pins-model";
import { startAgentInSlot } from "./view-pins-store";

// Each terminal resumes its agent once per window, even when its meta echoes back before the clear lands.
const resumed = new Set<string>();

function useResumeAgent(blockId: string, value: unknown) {
    const command = readResumeAgent(value)?.command ?? "";
    useEffect(() => {
        if (!command || !blockId || resumed.has(blockId)) {
            return;
        }
        resumed.add(blockId);
        fireAndForget(async () => {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", blockId),
                meta: { [ResumeAgentMetaKey]: null } as MetaType,
            });
            await typeCommandWhenReady(blockId, command);
        });
    }, [blockId, command]);
}

export function AgentSlotBanner({ blockId, meta }: { blockId: string; meta: Record<string, any> }) {
    const t = useT();
    const agent = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const [starting, setStarting] = useState(false);
    useResumeAgent(blockId, meta?.[ResumeAgentMetaKey]);
    if (meta?.[AgentSlotMetaKey] !== true || agent != null) {
        return null;
    }
    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-black/20 px-2.5 py-1 text-11 leading-4 text-secondary"
            data-testid="agent-slot"
            role="note"
        >
            <span className="min-w-0 flex-1 truncate">{t("sidebar.pins.slot.text")}</span>
            <button
                type="button"
                className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                title={t("sidebar.pins.slot.startTitle")}
                disabled={starting}
                data-testid="agent-slot-start"
                onClick={() => {
                    setStarting(true);
                    startAgentInSlot(blockId).finally(() => setStarting(false));
                }}
            >
                {t("sidebar.pins.slot.start")}
                <MoltenWave />
            </button>
        </div>
    );
}
