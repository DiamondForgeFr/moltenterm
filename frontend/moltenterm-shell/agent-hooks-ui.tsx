// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The common hook dialog (#221, #1693): command proposals and Integration control the same exported component and
// store methods. Manual recipes stay read-only; persistent capabilities add explicitly approved managed mutations.

import { fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { AgentHookOffer, hookApplyTextKey, hookOfferTexts } from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";
import { DialogFrame } from "./dialog-frame";
import { useT } from "./i18n/i18n";
import { serverErrorText } from "./i18n/server-text";
import { MoltenWave } from "./molten-button";
import { openFileInPreview } from "./term-copy/term-copy";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const PrimaryButton =
    "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";
const CopiedMs = 2000;

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
    const [error, setError] = useState<string>(null);
    const [backup, setBackup] = useState<{ path: string; digest: string }>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const name = offer.agentname || offer.agent;
    const texts = hookOfferTexts(offer, (key) => t(key));
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
    const mutate = (remove: boolean) =>
        fireAndForget(async () => {
            if (busy) {
                return;
            }
            setBusy(true);
            setError(null);
            setBackup(null);
            try {
                const store = AgentHookOffers.getInstance();
                const result = remove ? await store.remove(offer) : await store.apply(offer);
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
                setBusy(false);
            }
        });
    const title = offer.persistent ? t("agent.hooks.persistentTitle", { name }) : t("agent.hooks.title", { name });
    const subtitle = offer.persistent ? t("agent.hooks.persistentSubtitle") : t("agent.hooks.subtitle");
    return (
        <DialogFrame
            role="molten-hook-offer-dialog"
            onEscape={busy ? undefined : onClose}
            title={title}
            subtitle={subtitle}
            wide
            buttons={
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
                            onClick={() => mutate(false)}
                            disabled={busy}
                            autoFocus
                            data-testid="agent-hooks-apply"
                        >
                            {t(hookApplyTextKey(offer))}
                            <MoltenWave />
                        </button>
                    ) : null}
                </>
            }
        >
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
                    {offer.canapply || offer.canremove ? (
                        <p className="text-secondary">{t("agent.hooks.backupNotice")}</p>
                    ) : null}
                    {backup?.digest === offer.configdigest ? (
                        <p className="text-secondary" data-testid="agent-hooks-backup">
                            {t("agent.hooks.backupCreated")} <code className="font-mono break-all">{backup.path}</code>
                        </p>
                    ) : null}
                    <p className="text-muted">{t("agent.hooks.persistentRestart", { name })}</p>
                </div>
            ) : (
                <p>
                    {t("agent.hooks.addTo")} <code className="font-mono text-primary">{offer.file}</code>
                    {t("agent.hooks.also", { also: texts.also })}
                </p>
            )}
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
        </DialogFrame>
    );
}
