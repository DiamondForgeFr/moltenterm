// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Under Settings › Agents › Integration (FR-SHELL-040, #947): the running agent sessions, each with or without
// MoltenTerm's integration, since a change of the settings applies only to sessions started afterwards.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import {
    integrationRunRows,
    integrationRunText,
    loadIntegrationRuns,
    type AgentIntegrationRun,
} from "../agent-integration-runs";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";

export function IntegrationRuns() {
    const t = useT();
    const agentData = useAtomValue(AgentStates.getInstance().dataAtom);
    const [runs, setRuns] = useState<AgentIntegrationRun[]>(null);
    // Read again when a session starts or ends, not on every state change of a running one.
    const runningKey = useMemo(
        () =>
            Object.values(agentData.states)
                .filter((s) => s?.agent || s?.agentname)
                .map((s) => s.blockid)
                .sort()
                .join(","),
        [agentData]
    );
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            let next: AgentIntegrationRun[] = [];
            try {
                next = await loadIntegrationRuns();
            } catch (e) {
                console.log("settings: no integration runs", e);
            }
            if (live) {
                setRuns(next);
            }
        });
        return () => {
            live = false;
        };
    }, [runningKey]);
    if (runs == null) {
        return null;
    }
    const rows = integrationRunRows(runs, agentData.states);
    return (
        <div className="molten-settings-row flex flex-col gap-1.5 px-5 py-3" data-testid="settings-integration-runs">
            <div className="text-12 font-medium text-primary">{t("settings.integrationRuns.title")}</div>
            {rows.length === 0 ? (
                <div className="text-12 text-muted">{t("settings.integrationRuns.none")}</div>
            ) : (
                <ul className="flex flex-col gap-1">
                    {rows.map((row) => (
                        <li key={row.blockId} className="flex min-w-0 items-center gap-2 text-12">
                            <i
                                aria-hidden
                                className={cn(
                                    "fa fa-solid text-11",
                                    row.integration === "on"
                                        ? "fa-check text-accent"
                                        : row.integration === "off"
                                          ? "fa-minus text-muted"
                                          : "fa-question text-muted"
                                )}
                            />
                            <span className="truncate text-secondary">{row.label}</span>
                            <span className="ml-auto shrink-0 text-muted">{integrationRunText(row.integration)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
