// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The hook setup offer (#221): a suggestion of the terminal's command panel (FR-SHELL-052,
// header/header-proposals.ts), and a dialog with the snippet to add, where to add it, a copy button and the guide,
// hosted by the pane header. Never a notification: the offer must not ask for attention. MoltenTerm never writes the
// agent's configuration.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AgentHookOffer, hookOfferQueryKey } from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";
import { AgentStates } from "./agent-state-store";
import { DialogFrame } from "./dialog-frame";
import { useProposalRequest } from "./header/header-proposals";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import { openFileInPreview } from "./term-copy/term-copy";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const CopyButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const CopiedMs = 2000;

export function AgentHookOfferHost({ blockId }: { blockId: string }) {
    const offers = AgentHookOffers.getInstance();
    const info = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const offer = useAtomValue(offers.visibleAtom(blockId));
    const [open, setOpen] = useState(false);
    const queryKey = hookOfferQueryKey(info);
    useEffect(() => {
        if (!queryKey) {
            return;
        }
        fireAndForget(() => offers.refresh(blockId));
    }, [blockId, queryKey]);
    useProposalRequest(blockId, "hooks", () => setOpen(offer != null));
    if (offer == null || !open) {
        return null;
    }
    const dismiss = () => {
        setOpen(false);
        fireAndForget(() => offers.dismiss(offer.agent));
    };
    return <AgentHookOfferDialog blockId={blockId} offer={offer} onClose={() => setOpen(false)} onDismiss={dismiss} />;
}

function AgentHookOfferDialog({
    blockId,
    offer,
    onClose,
    onDismiss,
}: {
    blockId: string;
    offer: AgentHookOffer;
    onClose: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const name = offer.agentname || offer.agent;
    const copy = () =>
        fireAndForget(async () => {
            await navigator.clipboard.writeText(offer.snippet);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), CopiedMs);
        });
    const openGuide = () =>
        fireAndForget(async () => {
            const path = await AgentHookOffers.getInstance().docPath();
            onClose();
            await openFileInPreview({ path, conn: "" }, blockId);
        });
    return (
        <DialogFrame
            role="molten-hook-offer-dialog"
            onEscape={onClose}
            title={t("agent.hooks.title", { name })}
            subtitle={t("agent.hooks.subtitle")}
            wide
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={onDismiss}>
                        {t("agent.hooks.dontOffer")}
                    </button>
                    <button type="button" className={PlainButton} onClick={onClose}>
                        {t("common.close")}
                    </button>
                    <button type="button" className={CopyButton} onClick={copy} autoFocus>
                        <i className={`fa fa-solid ${copied ? "fa-check" : "fa-copy"} mr-1.5`} />
                        {copied ? t("agent.hooks.copied") : t("agent.hooks.copy")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p className="text-secondary">{t("agent.hooks.intro", { name, brings: offer.brings })}</p>
            <p>
                {t("agent.hooks.addTo")} <code className="font-mono text-primary">{offer.file}</code>
                {t("agent.hooks.also", { also: offer.also })}
            </p>
            <pre
                className="max-h-64 overflow-auto rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre text-secondary select-text"
                data-language={offer.language}
            >
                {offer.snippet}
            </pre>
            <p className="text-muted">
                {t("agent.hooks.restart", { name })}{" "}
                <button type="button" className="cursor-pointer text-accent hover:underline" onClick={openGuide}>
                    {t("agent.hooks.guide")}
                </button>
            </p>
        </DialogFrame>
    );
}
