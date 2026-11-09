// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Companion's permission request card (#2155): what the agent asks to run, and the way to the terminal where the
// developer answers it. Hook-free, so the card is tested without a window.

import type { AgentStateInfo } from "../agent-state-model";
import type { TFunction } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { CompanionToolCall, formatArgs } from "./companion-model";

export type TerminalLocation = { workspaceid?: string; tabid?: string; blockid: string };

// The terminal the Companion follows, where its agent's state says it is; the block alone when no state is known.
export function permissionTerminalOf(target: string, info: AgentStateInfo): TerminalLocation {
    if (!target) {
        return null;
    }
    return { workspaceid: info?.workspaceid, tabid: info?.tabid, blockid: target };
}

export function PermissionRequestCard({
    request,
    t,
    onShowTerminal,
}: {
    request: CompanionToolCall;
    t: TFunction;
    onShowTerminal: () => void;
}) {
    if (request == null) {
        return null;
    }
    return (
        <div
            className="m-3 mb-0 rounded-4 border border-warning/60 bg-warning/10 p-2"
            data-testid="companion-permission"
        >
            <div className="mb-1 text-12 font-medium text-warning">
                {t("companion.permissionRequest")} · <span className="font-mono">{request.tool}</span>
            </div>
            {request.args ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-secondary">
                    {formatArgs(request.args)}
                </pre>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-11 text-muted">{t("companion.answerInTerminal")}</span>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                    data-testid="companion-permission-terminal"
                    onClick={onShowTerminal}
                >
                    {t("companion.goToTerminal")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}
