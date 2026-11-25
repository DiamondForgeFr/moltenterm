// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The common hook dialog (#221, #1693): command proposals and Integration control the same exported component and
// store methods. Manual recipes stay read-only; persistent capabilities add explicitly approved managed mutations.
// An update lists what differs, and a version that is not qualified asks for confirmation, never blocks (#2543).

import { fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import {
    AgentHookChange,
    AgentHookOffer,
    hookApplyNeedsConfirmation,
    hookApplyTextKey,
    hookChangeValue,
    hookOfferTexts,
} from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";
import { DialogFrame } from "./dialog-frame";
import { useT } from "./i18n/i18n";
import { serverErrorText } from "./i18n/server-text";
import { MoltenWave } from "./molten-button";
import { SectionBlock } from "./suite/suite";
import { openFileInPreview } from "./term-copy/term-copy";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const PrimaryButton =
    "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";
const WarningButton =
    "molten-btn molten-btn-warning cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";
const CopiedMs = 2000;

type T = (key: string, vars?: Record<string, unknown>) => string;

function HookChangeRow({ change, name, t }: { change: AgentHookChange; name: string; t: T }) {
    if (change.kind !== "changed") {
        return (
            <li className="flex gap-2" data-testid="agent-hooks-change">
                <code className="font-mono text-primary">{change.event}</code>
                <span className={change.kind === "added" ? "text-success" : "text-warning"}>
                    {t(`agent.hooks.changes.${change.kind}`)}
                </span>
            </li>
        );
    }
    const label = t(`agent.hooks.changes.field.${change.field}`, { name });
    if (change.field === "block") {
        return (
            <li data-testid="agent-hooks-change" className="text-secondary">
                {label}
            </li>
        );
    }
    return (
        <li className="flex flex-col gap-0.5" data-testid="agent-hooks-change">
            <span className="text-secondary">
                {change.event ? <code className="mr-1.5 font-mono text-primary">{change.event}</code> : null}
                {label}
            </span>
            <span className="font-mono text-11 break-all">
                <span className="text-muted line-through">{hookChangeValue(change, change.installed, t)}</span>
                <span className="mx-1.5 text-muted">→</span>
                <span className="text-primary">{hookChangeValue(change, change.available, t)}</span>
            </span>
        </li>
    );
}

function HookChanges({ offer, name, t }: { offer: AgentHookOffer; name: string; t: T }) {
    if (!offer.changes?.length) {
        return null;
    }
    return (
        <SectionBlock title={t("agent.hooks.changes.title")} data-testid="agent-hooks-changes">
            <ul className="flex flex-col gap-1.5 text-12">
                {offer.changes.map((change, i) => (
                    <HookChangeRow key={i} change={change} name={name} t={t} />
                ))}
            </ul>
        </SectionBlock>
    );
}

function UnqualifiedNotice({ offer, name, t }: { offer: AgentHookOffer; name: string; t: T }) {
    const qualified = offer.qualifiedkimiversion;
    const body = offer.currentkimiversion
        ? t("agent.hooks.unqualified.body", { name, version: offer.currentkimiversion, qualified })
        : t("agent.hooks.unqualified.bodyUnknown", { name, qualified });
    return (
        <SectionBlock title={t("agent.hooks.unqualified.title")} data-testid="agent-hooks-unqualified">
            <p className="text-warning">{body}</p>
            <p className="text-secondary">{t("agent.hooks.unqualified.risk")}</p>
        </SectionBlock>
    );
}

// The second step of an apply on a version that is not qualified: it asks, and Cancel returns to the dialog.
export function HookConfirmButtons({
    busy,
    onCancel,
    onConfirm,
    t,
}: {
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
    t: T;
}) {
    return (
        <>
            <span className="mr-auto text-secondary" data-testid="agent-hooks-confirm-ask">
                {t("agent.hooks.unqualified.ask")}
            </span>
            <button type="button" className={PlainButton} onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
            </button>
            <button
                type="button"
                className={WarningButton}
                onClick={onConfirm}
                disabled={busy}
                autoFocus
                data-testid="agent-hooks-confirm"
            >
                {t("agent.hooks.unqualified.confirm")}
                <MoltenWave />
            </button>
        </>
    );
}

export function AgentHookOfferDialog({
    blockId,
    offer,
    onClose,
    onDismiss,
}: {
    blockId: string;
    offer: AgentHookOffer;
    onClose: () => void;
    onDismiss?: () => void;
}) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const [backup, setBackup] = useState<{ path: string; digest: string }>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const name = offer.agentname || offer.agent;
    const texts = hookOfferTexts(offer, (key) => t(key));
    const needsConfirmation = hookApplyNeedsConfirmation(offer);
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
    const mutate = (remove: boolean, confirmed = false) =>
        fireAndForget(async () => {
            if (busy) {
                return;
            }
            setBusy(true);
            setError(null);
            setBackup(null);
            try {
                const store = AgentHookOffers.getInstance();
                const result = remove ? await store.remove(offer) : await store.apply(offer, confirmed);
                if (result.backuppath) {
                    setBackup({ path: result.backuppath, digest: result.offer.configdigest });
                }
            } catch (e) {
                setError(serverErrorText(e));
                try {
                    await AgentHookOffers.getInstance().refresh(blockId);
                } catch {
                    // The dialog retains the actionable server error; the next opening retries the status.
                }
            } finally {
                setConfirming(false);
                setBusy(false);
            }
        });
    const applyClick = () => {
        if (needsConfirmation) {
            setConfirming(true);
            return;
        }
        mutate(false);
    };
    const title = offer.persistent ? t("agent.hooks.persistentTitle", { name }) : t("agent.hooks.title", { name });
    const subtitle = offer.persistent ? t("agent.hooks.persistentSubtitle") : t("agent.hooks.subtitle");
    const buttons = confirming ? (
        <HookConfirmButtons
            busy={busy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => mutate(false, true)}
            t={t}
        />
    ) : (
        <>
            {onDismiss != null ? (
                <button type="button" className={PlainButton} onClick={onDismiss} disabled={busy}>
                    {t("agent.hooks.dontOffer")}
                </button>
            ) : null}
            <button type="button" className={PlainButton} onClick={onClose} disabled={busy}>
                {t("common.close")}
            </button>
            <button type="button" className={PlainButton} onClick={copy} disabled={busy}>
                <i className={`fa fa-solid ${copied ? "fa-check" : "fa-copy"} mr-1.5`} />
                {copied ? t("agent.hooks.copied") : t("agent.hooks.copy")}
            </button>
            {offer.canremove ? (
                <button
                    type="button"
                    className={PlainButton}
                    onClick={() => mutate(true)}
                    disabled={busy}
                    data-testid="agent-hooks-remove"
                >
                    {t("agent.hooks.remove")}
                </button>
            ) : null}
            {offer.canapply ? (
                <button
                    type="button"
                    className={PrimaryButton}
                    onClick={applyClick}
                    disabled={busy}
                    autoFocus
                    data-testid="agent-hooks-apply"
                >
                    {t(hookApplyTextKey(offer))}
                    <MoltenWave />
                </button>
            ) : null}
        </>
    );
    return (
        <DialogFrame
            role="molten-hook-offer-dialog"
            onEscape={busy ? undefined : confirming ? () => setConfirming(false) : onClose}
            title={title}
            subtitle={subtitle}
            wide
            suite
            buttons={buttons}
        >
            <div className="flex flex-col gap-3 pt-2">
                <p className="text-secondary">{t("agent.hooks.intro", { name, brings: texts.brings })}</p>
                {offer.persistent ? (
                    <div className="flex flex-col gap-2" data-testid="agent-hooks-persistent-details">
                        <div className="font-medium text-primary" data-testid="agent-hooks-status">
                            {t(`agent.hooks.status.${offer.status ?? "absent"}`, { name })}
                        </div>
                        <p className="text-secondary">
                            {t("agent.hooks.exactFile")} <code className="font-mono text-primary">{offer.file}</code>
                        </p>
                        <p className="text-secondary">
                            {t(`agent.hooks.explanation.${offer.status ?? "absent"}`, { name })}
                        </p>
                        {offer.errorcode ? (
                            <p className="text-warning" data-testid="agent-hooks-config-error">
                                {t(`agent.hooks.error.${offer.errorcode}`)}
                            </p>
                        ) : null}
                        <div className="flex flex-col gap-1 text-11 text-muted">
                            {offer.qualifiedkimiversion ? (
                                <div>{t("agent.hooks.qualifiedVersion", { version: offer.qualifiedkimiversion })}</div>
                            ) : null}
                            {offer.currentkimiversion ? (
                                <div>{t("agent.hooks.currentVersion", { version: offer.currentkimiversion })}</div>
                            ) : null}
                            {offer.installedkimiversion ? (
                                <div>{t("agent.hooks.installedVersion", { version: offer.installedkimiversion })}</div>
                            ) : null}
                            {offer.definitionversion ? (
                                <div>
                                    {t("agent.hooks.definitionVersion", {
                                        version: offer.installeddefinitionversion || offer.definitionversion,
                                        target: offer.definitionversion,
                                    })}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <>
                        {offer.changes?.length ? (
                            <p className="text-secondary" data-testid="agent-hooks-manual-update">
                                {t("agent.hooks.manualUpdate")}
                            </p>
                        ) : null}
                        <p>
                            {t("agent.hooks.addTo")} <code className="font-mono text-primary">{offer.file}</code>
                            {t("agent.hooks.also", { also: texts.also })}
                        </p>
                    </>
                )}
                <HookChanges offer={offer} name={name} t={t} />
                {needsConfirmation ? <UnqualifiedNotice offer={offer} name={name} t={t} /> : null}
                {offer.persistent && (offer.canapply || offer.canremove) ? (
                    <p className="text-secondary">{t("agent.hooks.backupNotice")}</p>
                ) : null}
                {offer.persistent && backup?.digest === offer.configdigest ? (
                    <p className="text-secondary" data-testid="agent-hooks-backup">
                        {t("agent.hooks.backupCreated")} <code className="font-mono break-all">{backup.path}</code>
                    </p>
                ) : null}
                {offer.persistent ? <p className="text-muted">{t("agent.hooks.persistentRestart", { name })}</p> : null}
                <pre
                    className="max-h-64 overflow-auto rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre text-secondary select-text"
                    data-language={offer.language}
                >
                    {offer.snippet}
                </pre>
                <p className="text-muted">
                    {offer.persistent ? t("agent.hooks.manualFallback") : t("agent.hooks.restart", { name })}{" "}
                    <button type="button" className="cursor-pointer text-accent hover:underline" onClick={openGuide}>
                        {t("agent.hooks.guide")}
                    </button>
                </p>
                {error ? (
                    <p className="text-danger" role="alert" data-testid="agent-hooks-error">
                        {error}
                    </p>
                ) : null}
            </div>
        </DialogFrame>
    );
}
