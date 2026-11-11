// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// His agent's permission requests in his talk window (#2257): what is asked in plain words, the exact command or path,
// and the developer's answer (Allow once, Always allow when his agent offers it, Deny), sent to that request alone
// (pkg/molten/brokksession/permit.go). The approvals boss:autoapprove made show as lines, so nothing runs unseen.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BrokkSession } from "./brokk-session";
import { AutoApproval, PermissionAsk, PermitDecision, permitChoices } from "./brokk-talk-model";

const DecisionKeys: Record<PermitDecision, string> = {
    allow: "boss.panel.talk.permission.allow",
    always: "boss.panel.talk.permission.always",
    deny: "boss.panel.talk.permission.deny",
};

export function BrokkPermissionCard({ ask, name }: { ask: PermissionAsk; name: string }) {
    const t = useT();
    const [sending, setSending] = useState(false);
    const answer = async (decision: PermitDecision) => {
        if (sending) {
            return;
        }
        setSending(true);
        try {
            await BrokkSession.getInstance().permit(ask, decision);
        } finally {
            setSending(false);
        }
    };
    return (
        <div
            role="group"
            aria-label={t(`boss.panel.talk.permission.kind.${ask.kind}`, { name })}
            data-testid="brokk-permission"
            data-kind={ask.kind}
            className="flex flex-col gap-1.5 rounded-4 border border-border p-2 text-12"
        >
            <span className="text-secondary">{t(`boss.panel.talk.permission.kind.${ask.kind}`, { name })}</span>
            <code
                data-testid="brokk-permission-subject"
                className="block max-h-24 overflow-auto rounded-4 bg-black/20 px-1.5 py-1 font-mono text-11 break-all whitespace-pre-wrap text-primary"
            >
                {ask.subject}
            </code>
            <span className="inline-flex flex-wrap justify-end gap-1.5">
                {permitChoices(ask).map((decision) => (
                    <button
                        key={decision}
                        type="button"
                        disabled={sending}
                        data-testid={`brokk-permission-${decision}`}
                        onClick={() => void answer(decision)}
                        className={
                            decision === "allow"
                                ? "molten-btn cursor-pointer rounded px-2 py-0.5 text-11"
                                : "cursor-pointer rounded border border-border px-2 py-0.5 text-11 text-primary hover:bg-hover"
                        }
                    >
                        {t(DecisionKeys[decision])}
                        {decision === "allow" ? <MoltenWave /> : null}
                    </button>
                ))}
            </span>
        </div>
    );
}

export function BrokkApprovedLines({ approved, name }: { approved: AutoApproval[]; name: string }) {
    const t = useT();
    if (approved.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-col gap-0.5 text-11 text-muted" data-testid="brokk-approved">
            {approved.map((a) => (
                <li key={a.id} data-testid="brokk-approved-line">
                    {t("boss.panel.talk.permission.autoApproved", { name })}{" "}
                    <code className="font-mono text-secondary break-all">{a.subject}</code>
                </li>
            ))}
        </ul>
    );
}

// What the talk window shows of his agent's requests: the waiting one, the note of an answer that came too late, and
// the approvals made without asking.
export function BrokkPermissions({ name }: { name: string }) {
    const t = useT();
    const session = BrokkSession.getInstance();
    const ask = useAtomValue(session.permissionAtom, { store: globalStore });
    const gone = useAtomValue(session.permissionGoneAtom, { store: globalStore });
    const approved = useAtomValue(session.approvedAtom, { store: globalStore });
    return (
        <>
            <BrokkApprovedLines approved={approved} name={name} />
            {ask != null ? <BrokkPermissionCard ask={ask} name={name} /> : null}
            {ask == null && gone ? (
                <div role="status" className="text-11 text-secondary" data-testid="brokk-permission-gone">
                    {t("boss.panel.talk.permission.gone", { name })}
                </div>
            ) : null}
        </>
    );
}
