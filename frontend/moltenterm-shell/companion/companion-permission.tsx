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

// The body of the permission block (#2441): who asks to run what, its arguments sunk in mono, and the way to the
// terminal where the developer answers it.
export function PermissionRequestCard({
    request,
    t,
    onShowTerminal,
    agent,
}: {
    request: CompanionToolCall;
    t: TFunction;
    onShowTerminal: () => void;
    // The agent's first name, "" when unknown.
    agent?: string;
}) {
    if (request == null) {
        return null;
    }
    const tool = <span data-mono="">{request.tool}</span>;
    return (
        <div className="flex flex-col gap-2.5" data-testid="companion-permission">
            <div className="mt-cdash-perm-line">
                {agent ? t("companion.dash.wantsToRun", { name: agent }) : t("companion.dash.wantsToRunPlain")} {tool}
            </div>
            {request.args ? <pre className="mt-cdash-perm-args">{formatArgs(request.args)}</pre> : null}
            <div className="mt-cdash-act">
                <span>{t("companion.answerInTerminal")}</span>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
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
