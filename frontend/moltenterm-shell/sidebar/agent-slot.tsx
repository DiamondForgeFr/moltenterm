// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// An agent slot (FR-SHELL-080): a view pinned everywhere opens in each workspace with its own agent, so the terminal
// that held an agent when the view was pinned opens empty, in the project's folder, and offers to start one. Nothing
// starts unasked; the line goes once an agent runs there.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { AgentSlotMetaKey } from "./view-pins-model";
import { startAgentInSlot } from "./view-pins-store";

export function AgentSlotBanner({ blockId, meta }: { blockId: string; meta: Record<string, any> }) {
    const t = useT();
    const agent = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const [starting, setStarting] = useState(false);
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
                className="molten-btn cursor-pointer rounded px-2 py-0.5 text-11"
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
