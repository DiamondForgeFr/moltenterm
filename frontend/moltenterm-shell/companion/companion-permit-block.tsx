// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's permission block (FR-SHELL-018, #2155, #2441, #2474): the request the agent waits on. One MoltenTerm
// holds for the companion is answered here (Allow, Deny, Answer in the terminal); one the deny list keeps for the
// developer, and any request only the transcript shows, send the developer to the terminal, which the agent's own
// prompt answers as it always did.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { goToAgent } from "../agent-info/agent-info-hooks";
import type { AgentStateInfo } from "../agent-state-model";
import { useT } from "../i18n/i18n";
import { CompanionBlock } from "./companion-block";
import { ArrangeGhost } from "./companion-ghost";
import { CompanionView, permissionRequest } from "./companion-model";
import { PermissionRequestCard, permissionTerminalOf, PermitRequestCard } from "./companion-permission";
import { PermitDecision, requestOfBlock } from "./companion-permit-model";
import { PermitModel, usePermitState, useTick } from "./companion-permit-store";
import { SectionTiles } from "./companion-section-tiles";

export function PermissionBlock({
    target,
    view,
    agentState,
    lead,
}: {
    target: string;
    view: CompanionView;
    agentState: AgentStateInfo;
    // The agent's first name, "" when unknown.
    lead: string;
}) {
    const t = useT();
    const model = PermitModel.getInstance();
    const state = usePermitState();
    const watches = useAtomValue(model.watchesAtom);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const held = requestOfBlock(state, target);
    const transcript = permissionRequest(view.pending, agentState?.state);
    const now = useTick(held?.state === "held");
    if (held == null && transcript == null) {
        return <ArrangeGhost key="permission" id="permission" kind="when" />;
    }
    const showTerminal = () => fireAndForget(() => goToAgent(permissionTerminalOf(target, agentState)));
    const answer = async (decision: PermitDecision) => {
        setBusy(true);
        setError("");
        try {
            const result = await model.answer(held, decision);
            if (result.status === "gone") {
                setError(t("companion.permit.gone"));
            } else if (result.status !== "answered") {
                setError(t("companion.permit.failed"));
            } else if (decision === "terminal") {
                showTerminal();
            }
        } catch (e) {
            console.log("permission gate: the answer failed", e);
            setError(t("companion.permit.failed"));
        }
        setBusy(false);
    };
    // A run that cannot be held (started before the update) says so under the way to the terminal.
    const watch = watches[target];
    const hint = watch != null && watch.available && !watch.holds ? t("companion.permit.restart") : "";
    return (
        <CompanionBlock
            key="permission"
            flowId="permission"
            tone="waiting"
            label={t("companion.permissionRequest")}
            icon={SectionTiles.permission}
        >
            {held != null ? (
                <PermitRequestCard
                    request={held}
                    t={t}
                    agent={lead}
                    now={now}
                    busy={busy}
                    error={error}
                    onAnswer={answer}
                    onShowTerminal={showTerminal}
                />
            ) : (
                <PermissionRequestCard
                    request={transcript}
                    t={t}
                    agent={lead}
                    onShowTerminal={showTerminal}
                    hint={hint}
                />
            )}
        </CompanionBlock>
    );
}
