// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings › General › New workspace views (FR-SHELL-092, DS-SHELL-132): the template a workspace created from now on
// starts with. Add, remove, rename and order the views; choose, add, remove and order each view's panels; Reset goes
// back to Scoping and Integration. Existing workspaces never change.

import { getSettingsKeyAtom } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import { writeSettings } from "../command-panel/bindings";
import { useT } from "../i18n/i18n";
import { PageCard } from "../settings/settings-page";
import { suiteIcon } from "../suite/suite-icons";
import {
    addPanel,
    addView,
    movePanel,
    moveView,
    NewWorkspaceViewsKey,
    readTemplate,
    removePanel,
    removeView,
    renameView,
    replacePanel,
    TemplateView,
    templateViewName,
    WorkspaceViewPanels,
} from "./workspace-views-model";

const DefaultTemplate = readTemplate((builtinDefaults as Record<string, unknown>)[NewWorkspaceViewsKey]);

function writeTemplate(views: TemplateView[]) {
    fireAndForget(() => writeSettings({ [NewWorkspaceViewsKey]: views }));
}

const SelectClass =
    "h-row min-w-0 flex-1 cursor-pointer rounded-4 border border-line-strong bg-surface-2 px-2 pr-1 text-12 text-primary outline-none focus:border-accent";
const InputClass =
    "h-row min-w-0 flex-1 rounded-4 border border-line-strong bg-surface-2 px-2 text-12 font-medium text-primary outline-none focus:border-accent";
const IconButton =
    "molten-btn-ghost inline-flex h-row w-row shrink-0 cursor-pointer items-center justify-center rounded-4 text-12 disabled:opacity-40";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12 disabled:opacity-40";

function IconAction({
    icon,
    label,
    disabled,
    onClick,
}: {
    icon: string;
    label: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={IconButton}
            title={label}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
        >
            <i className={`fa-solid fa-${icon}`} />
        </button>
    );
}

function ViewEditor({ views, i }: { views: TemplateView[]; i: number }) {
    const t = useT();
    const view = views[i];
    const name = templateViewName(view, t);
    const commit = (value: string) => {
        if (value.trim() && value.trim() !== name) {
            writeTemplate(renameView(views, i, value));
        }
    };
    return (
        <li className="flex flex-col gap-1.5 rounded-4 border border-line px-3 py-2" data-template-view={i}>
            <div className="flex min-w-0 items-center gap-2">
                <input
                    key={name}
                    type="text"
                    defaultValue={name}
                    aria-label={t("workspaceViews.settings.name", { n: i + 1 })}
                    className={InputClass}
                    onBlur={(e) => commit(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                        if (e.key === "Escape") {
                            e.currentTarget.value = name;
                            e.currentTarget.blur();
                        }
                    }}
                    data-testid="workspace-view-name"
                />
                <IconAction
                    icon="arrow-up"
                    label={t("workspaceViews.settings.moveViewUp", { name })}
                    disabled={i === 0}
                    onClick={() => writeTemplate(moveView(views, i, -1))}
                />
                <IconAction
                    icon="arrow-down"
                    label={t("workspaceViews.settings.moveViewDown", { name })}
                    disabled={i === views.length - 1}
                    onClick={() => writeTemplate(moveView(views, i, 1))}
                />
                <IconAction
                    icon="trash"
                    label={t("workspaceViews.settings.removeView", { name })}
                    onClick={() => writeTemplate(removeView(views, i))}
                />
            </div>
            <ul className="flex flex-col gap-1 pl-3">
                {view.panels.map((kind, p) => (
                    <li key={`${p}:${kind}`} className="flex min-w-0 items-center gap-2 text-12" data-panel={kind}>
                        <span className="w-4 shrink-0 text-right text-muted">{p + 1}</span>
                        <select
                            aria-label={t("workspaceViews.settings.panel", { n: p + 1, name })}
                            value={kind}
                            onChange={(e) => writeTemplate(replacePanel(views, i, p, e.target.value))}
                            className={SelectClass}
                        >
                            {WorkspaceViewPanels.map((opt) => (
                                <option key={opt.kind} value={opt.kind}>
                                    {t(opt.labelKey)}
                                </option>
                            ))}
                        </select>
                        <IconAction
                            icon="arrow-up"
                            label={t("workspaceViews.settings.movePanelUp")}
                            disabled={p === 0}
                            onClick={() => writeTemplate(movePanel(views, i, p, -1))}
                        />
                        <IconAction
                            icon="arrow-down"
                            label={t("workspaceViews.settings.movePanelDown")}
                            disabled={p === view.panels.length - 1}
                            onClick={() => writeTemplate(movePanel(views, i, p, 1))}
                        />
                        <IconAction
                            icon="xmark"
                            label={t("workspaceViews.settings.removePanel")}
                            disabled={view.panels.length <= 1}
                            onClick={() => writeTemplate(removePanel(views, i, p))}
                        />
                    </li>
                ))}
            </ul>
            <div className="pl-3">
                <button
                    type="button"
                    className={GhostButton}
                    data-testid="workspace-view-add-panel"
                    onClick={() => writeTemplate(addPanel(views, i))}
                >
                    <i className="fa-solid fa-plus" />
                    {t("workspaceViews.settings.addPanel")}
                </button>
            </div>
        </li>
    );
}

export function NewWorkspaceViewsCard() {
    const t = useT();
    const setting = useAtomValue(getSettingsKeyAtom(NewWorkspaceViewsKey as keyof SettingsType));
    const views = readTemplate(setting);
    const isDefault = JSON.stringify(views) === JSON.stringify(DefaultTemplate);
    return (
        <PageCard
            title={t("workspaceViews.settings.title")}
            hint={t("workspaceViews.settings.hint")}
            icon={suiteIcon("workspace")}
        >
            <div className="flex flex-col gap-2 px-5 py-3" data-testid="settings-new-workspace-views">
                {views.length === 0 ? (
                    <div className="text-12 text-muted">{t("workspaceViews.settings.empty")}</div>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {views.map((v, i) => (
                            <ViewEditor key={`${i}:${v.name ?? v.namekey ?? ""}`} views={views} i={i} />
                        ))}
                    </ul>
                )}
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className={cn(GhostButton)}
                        data-testid="workspace-view-add"
                        onClick={() => writeTemplate(addView(views, ""))}
                    >
                        <i className="fa-solid fa-plus" />
                        {t("workspaceViews.settings.addView")}
                    </button>
                    <button
                        type="button"
                        className={GhostButton}
                        data-testid="workspace-view-reset"
                        disabled={isDefault}
                        onClick={() => fireAndForget(() => writeSettings({ [NewWorkspaceViewsKey]: null }))}
                    >
                        <i className="fa-solid fa-rotate-left" />
                        {t("workspaceViews.settings.reset")}
                    </button>
                </div>
            </div>
        </PageCard>
    );
}
