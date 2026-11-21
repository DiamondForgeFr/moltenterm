// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Integration details generalize launcher additions and persistent hook management. Both entry points open the same
// controlled AgentHookOfferDialog; a persistent provider never fabricates a launcher report or per-run settings.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useState } from "react";
import { hookApplyTextKey } from "../agent-hooks-model";
import { AgentHookOffers } from "../agent-hooks-store";
import { writeSettings } from "../command-panel/bindings";
import { useT } from "../i18n/i18n";
import { openFileInPreview } from "../term-copy/term-copy";
import {
    integrationSetting,
    integrationSettingText,
    IntegrationsGuide,
    integrationVia,
    turnOffForAgent,
    turnOffForEveryAgent,
    turnOnForAgent,
} from "./companion-integration-model";
import { CompanionIntegrationItem, CompanionView, integrationItemText } from "./companion-model";

const AgentHookOfferDialog = lazy(() => import("../agent-hooks-ui").then((m) => ({ default: m.AgentHookOfferDialog })));

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2.5 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export function IntegratedBadge({
    onOpen,
    className,
    persistent = false,
    short = false,
}: {
    onOpen: () => void;
    className?: string;
    persistent?: boolean;
    // The hero's tools say it in a word, the full name in the tooltip and for assistive technology (#2441).
    short?: boolean;
}) {
    const t = useT();
    const full = t(persistent ? "companion.integration.persistentTitle" : "companion.integration.title");
    if (short) {
        return (
            <button
                type="button"
                onClick={onOpen}
                title={full}
                aria-label={full}
                className={className}
                data-testid="companion-integrated"
            >
                <i className="fa fa-solid fa-plug text-11" aria-hidden />
                {t(persistent ? "companion.integration.persistentShort" : "companion.integration.short")}
            </button>
        );
    }
    return (
        <button
            type="button"
            onClick={onOpen}
            title={t(persistent ? "companion.integration.persistentBadgeTitle" : "companion.integration.badgeTitle")}
            className={cn(
                "cursor-pointer rounded-6 px-1 py-0.5 text-11 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary",
                className
            )}
            data-testid="companion-integrated"
        >
            <i className="fa fa-solid fa-plug mr-1 text-11" aria-hidden />
            {t(persistent ? "companion.integration.persistentTitle" : "companion.integration.title")}
        </button>
    );
}

function ItemList({ items, testId }: { items: CompanionIntegrationItem[]; testId: string }) {
    return (
        <ul className="flex flex-col gap-1" data-testid={testId}>
            {items.map((item, i) => {
                const text = integrationItemText(item);
                return (
                    <li key={`${item.kind}:${i}`} className="text-12 leading-5 text-primary">
                        {text.name}
                        {text.reason ? <span className="text-muted">: {text.reason}</span> : null}
                    </li>
                );
            })}
        </ul>
    );
}

export function IntegrationDetails({
    view,
    target,
    onClose,
}: {
    view: CompanionView;
    target: string;
    onClose: () => void;
}) {
    const t = useT();
    const offers = AgentHookOffers.getInstance();
    const hookOffer = useAtomValue(offers.detailsAtom(target));
    const settings = useAtomValue(atoms.settingsAtom) as Record<string, unknown>;
    const [error, setError] = useState<string>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const integration = view.integration;
    const persistent = hookOffer?.persistent === true;
    const agent = hookOffer?.agent || integration?.agent || view.agent;
    const name = hookOffer?.agentname || view.agentname || agent;
    const setting = integrationSetting(settings, agent);
    const settingText = integrationSettingText(setting, name);
    const via = integrationVia(integration);
    useEffect(() => {
        fireAndForget(() => offers.refresh(target));
    }, [target]);
    const write = (data: Record<string, unknown>) =>
        fireAndForget(async () => {
            try {
                setError(null);
                await writeSettings(data);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    const openGuide = () =>
        fireAndForget(async () => {
            try {
                const path = await AgentHookOffers.getInstance().docPath(IntegrationsGuide);
                await openFileInPreview({ path, conn: "" }, target);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    const dismiss = () => {
        setDialogOpen(false);
        fireAndForget(() => offers.dismiss(hookOffer.agent, hookOffer.updatekind ? hookOffer.updatekey : undefined));
    };
    return (
        <>
            <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-4" data-testid="companion-integration">
                <div className="flex items-start gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t("companion.history.back")}
                        title={t("companion.history.back")}
                        className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                        data-testid="companion-integration-back"
                    >
                        <i className="fa fa-solid fa-arrow-left" />
                    </button>
                    <div>
                        <div className="text-13 leading-5 font-medium text-primary">
                            {t(persistent ? "companion.integration.persistentTitle" : "companion.integration.title")}
                        </div>
                        <div className="text-12 text-secondary">
                            {t(persistent ? "companion.integration.persistentHint" : "companion.integration.hint", {
                                name,
                            })}
                        </div>
                    </div>
                </div>
                {integration?.added?.length ? (
                    <div className="flex flex-col gap-1.5">
                        <div className="text-11 font-semibold tracking-wide text-muted uppercase">
                            {t("companion.integration.added")}
                        </div>
                        <ItemList items={integration.added} testId="companion-integration-added" />
                    </div>
                ) : null}
                {integration?.skipped?.length ? (
                    <div className="flex flex-col gap-1.5">
                        <div className="text-11 font-semibold tracking-wide text-muted uppercase">
                            {t("companion.integration.skipped")}
                        </div>
                        <ItemList items={integration.skipped} testId="companion-integration-skipped" />
                    </div>
                ) : null}
                {integration != null ? (
                    <div className="flex flex-col gap-1 text-11 text-muted">
                        {integration.realpath ? (
                            <div>
                                {t("companion.integration.runs")}{" "}
                                <span className="font-mono break-all">{integration.realpath}</span>
                            </div>
                        ) : null}
                        {via.map((v) => (
                            <div key={v} className="font-mono break-all">
                                {v}
                            </div>
                        ))}
                    </div>
                ) : null}
                {persistent ? (
                    <div
                        className="flex flex-col gap-2 border-t border-border pt-3"
                        data-testid="companion-persistent-hooks"
                    >
                        <div className="text-12 font-medium text-primary" data-testid="companion-persistent-status">
                            {t(`agent.hooks.status.${hookOffer.status ?? "absent"}`, { name })}
                        </div>
                        <div className="text-12 text-secondary">
                            {t(`agent.hooks.explanation.${hookOffer.status ?? "absent"}`, { name })}
                        </div>
                        <div className="text-11 text-muted">
                            {t("agent.hooks.exactFile")} <code className="font-mono break-all">{hookOffer.file}</code>
                        </div>
                        <div className="flex flex-col gap-1 text-11 text-muted">
                            {hookOffer.currentkimiversion ? (
                                <div>{t("agent.hooks.currentVersion", { version: hookOffer.currentkimiversion })}</div>
                            ) : null}
                            {hookOffer.installedkimiversion ? (
                                <div>
                                    {t("agent.hooks.installedVersion", { version: hookOffer.installedkimiversion })}
                                </div>
                            ) : null}
                            {hookOffer.definitionversion ? (
                                <div>
                                    {t("agent.hooks.definitionVersion", {
                                        version: hookOffer.installeddefinitionversion || hookOffer.definitionversion,
                                        target: hookOffer.definitionversion,
                                    })}
                                </div>
                            ) : null}
                            {hookOffer.events?.length ? (
                                <div>{t("agent.hooks.eventCount", { count: hookOffer.events.length })}</div>
                            ) : null}
                        </div>
                        {hookOffer.errorcode ? (
                            <div className="text-12 text-warning">{t(`agent.hooks.error.${hookOffer.errorcode}`)}</div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                className={PlainButton}
                                onClick={() => setDialogOpen(true)}
                                data-testid="companion-persistent-manage"
                            >
                                {t(
                                    hookOffer.canapply
                                        ? hookApplyTextKey(hookOffer)
                                        : hookOffer.action === "review"
                                          ? "agent.hooks.review"
                                          : "agent.hooks.manage"
                                )}
                            </button>
                            {hookOffer.canremove ? (
                                <button
                                    type="button"
                                    className={PlainButton}
                                    onClick={() => setDialogOpen(true)}
                                    data-testid="companion-persistent-remove"
                                >
                                    {t("agent.hooks.remove")}
                                </button>
                            ) : null}
                        </div>
                        <div className="text-11 text-muted">{t("agent.hooks.persistentRestart", { name })}</div>
                    </div>
                ) : null}
                {integration != null ? (
                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        {settingText ? (
                            <div className="text-12 text-secondary" data-testid="companion-integration-off">
                                {settingText}
                            </div>
                        ) : (
                            <div className="text-12 text-secondary">{t("companion.integration.nextLaunch")}</div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                            {setting === "on" ? (
                                <>
                                    <button
                                        type="button"
                                        className={PlainButton}
                                        onClick={() => write(turnOffForAgent(settings, agent))}
                                        data-testid="companion-integration-turnoff-agent"
                                    >
                                        {t("companion.integration.turnOffAgent", { name })}
                                    </button>
                                    <button
                                        type="button"
                                        className={PlainButton}
                                        onClick={() => write(turnOffForEveryAgent())}
                                        data-testid="companion-integration-turnoff-all"
                                    >
                                        {t("companion.integration.turnOffAll")}
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className={PlainButton}
                                    onClick={() => write(turnOnForAgent(settings, agent))}
                                    data-testid="companion-integration-turnon"
                                >
                                    {t("companion.integration.turnOn")}
                                </button>
                            )}
                        </div>
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <button
                        type="button"
                        className="cursor-pointer rounded-6 px-2 py-1 text-12 text-accent hover:underline"
                        onClick={openGuide}
                        data-testid="companion-integration-guide"
                    >
                        {t("companion.integration.guide")}
                    </button>
                </div>
                {error ? <div className="text-12 text-danger">{error}</div> : null}
            </div>
            {dialogOpen && hookOffer != null ? (
                <Suspense fallback={null}>
                    <AgentHookOfferDialog
                        blockId={target}
                        offer={hookOffer}
                        onClose={() => setDialogOpen(false)}
                        onDismiss={dismiss}
                    />
                </Suspense>
            ) : null}
        </>
    );
}
