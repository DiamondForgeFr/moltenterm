// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Integrated by MoltenTerm" in the session bar and the details it opens (FR-SHELL-040-AC3, DS-SHELL-051): what the
// launcher added to this run and what it left alone, the guide, and the switches that turn it off from the next
// launch.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
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

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2.5 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export function IntegratedBadge({ onOpen, className }: { onOpen: () => void; className?: string }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onOpen}
            title={t("companion.integration.badgeTitle")}
            className={cn(
                "cursor-pointer rounded-6 px-1 py-0.5 text-11 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary",
                className
            )}
            data-testid="companion-integrated"
        >
            <i className="fa fa-solid fa-plug mr-1 text-11" aria-hidden />
            {t("companion.integration.title")}
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
    const settings = useAtomValue(atoms.settingsAtom) as Record<string, unknown>;
    const [error, setError] = useState<string>(null);
    const integration = view.integration;
    const agent = integration?.agent || view.agent;
    const name = view.agentname || agent;
    const setting = integrationSetting(settings, agent);
    const settingText = integrationSettingText(setting, name);
    const via = integrationVia(integration);
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
    return (
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
                    <div className="text-13 leading-5 font-medium text-primary">{t("companion.integration.title")}</div>
                    <div className="text-12 text-secondary">{t("companion.integration.hint", { name })}</div>
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
            <div className="flex flex-col gap-1 text-11 text-muted">
                {integration?.realpath ? (
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
        </div>
    );
}
