// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The hook setup offer in the pane header (#221): a quiet chip next to the agent label, the same place and shape as
// the worktree link offer, and a dialog with the snippet to add, where to add it, a copy button and the guide. Never
// a notification: the offer must not ask for attention. MoltenTerm never writes the agent's configuration.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AgentHookOffer, hookOfferQueryKey } from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";
import { AgentStates } from "./agent-state-store";
import { DialogFrame, useEscape } from "./dialog-frame";
import { MoltenWave } from "./molten-button";
import { openFileInPreview } from "./term-copy/term-copy";

const ChipButton = "cursor-pointer rounded-6 px-1 hover:bg-hover hover:text-primary";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const CopyButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const CopiedMs = 2000;

export function AgentHookOfferChip({ blockId }: { blockId: string }) {
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
    if (offer == null) {
        return null;
    }
    const name = offer.agentname || offer.agent;
    const dismiss = () => {
        setOpen(false);
        fireAndForget(() => offers.dismiss(offer.agent));
    };
    return (
        <>
            <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-4 border border-border px-1 text-11 leading-[16px] text-muted"
                title={`${name} shows its states from its output only.\nIts hooks make them precise: ${offer.brings}.`}
                onMouseDown={(e) => e.stopPropagation()}
                data-role="molten-hook-offer"
            >
                <button
                    type="button"
                    className={ChipButton}
                    aria-label={`Set up ${name}'s hooks for precise states`}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpen(true);
                    }}
                >
                    <i className="fa fa-solid fa-plug mr-1 text-11" />
                    Set up hooks
                </button>
                <button
                    type="button"
                    className={ChipButton}
                    title={`Don't offer again for ${name}`}
                    aria-label={`Don't offer the hooks again for ${name}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        dismiss();
                    }}
                >
                    <i className="fa fa-solid fa-xmark text-11" />
                </button>
            </span>
            {open ? (
                <AgentHookOfferDialog
                    blockId={blockId}
                    offer={offer}
                    onClose={() => setOpen(false)}
                    onDismiss={dismiss}
                />
            ) : null}
        </>
    );
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
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEscape(true, onClose);
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
            title={`Precise states for ${name}`}
            subtitle="MoltenTerm never edits your agent's settings: you add this yourself."
            wide
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={onDismiss}>
                        Don't offer again
                    </button>
                    <button type="button" className={PlainButton} onClick={onClose}>
                        Close
                    </button>
                    <button type="button" className={CopyButton} onClick={copy} autoFocus>
                        <i className={`fa fa-solid ${copied ? "fa-check" : "fa-copy"} mr-1.5`} />
                        {copied ? "Copied" : "Copy"}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p className="text-secondary">
                Without hooks, MoltenTerm only sees when {name}'s output comes: working while it streams, idle once it
                is quiet. With them, the pane shows {offer.brings}.
            </p>
            <p>
                Add this to <code className="font-mono text-primary">{offer.file}</code>, {offer.also}:
            </p>
            <pre
                className="max-h-64 overflow-auto rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre text-secondary select-text"
                data-language={offer.language}
            >
                {offer.snippet}
            </pre>
            <p className="text-muted">
                Start {name} again after the change. Once its hooks report, this offer goes away.{" "}
                <button type="button" className="cursor-pointer text-accent hover:underline" onClick={openGuide}>
                    Read the agent states guide
                </button>
            </p>
        </DialogFrame>
    );
}
