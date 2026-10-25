// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 4 of the deployment pipeline setup (FR-MC-042): save the pipeline prepared at step 3 as a template on this
// computer, and the saved templates offered in step 2b's "Start from". A template keeps the flow and the hand steps;
// what belongs to the project is a blank filled in on the next one. Nothing here writes the project.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { TFunction, useLocale, useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { setupSaveTemplate } from "./release-setup-client";
import { BlockClass, ChipClass } from "./release-setup-detect";
import { FlowDiagram } from "./release-setup-diagram";
import { flowModel, SetupChannel, SetupDraft, SetupOptions } from "./release-setup-model";
import { AppTypes, SetupAppType } from "./release-setup-stepper";
import {
    canSaveTemplate,
    defaultNameParts,
    flowSummary,
    flowToSave,
    needText,
    SetupTemplate,
    SetupTemplateFit,
    templateBlanks,
    TextOf,
} from "./release-setup-template-model";

const InputClass =
    "w-full max-w-96 rounded-4 border border-border bg-transparent px-2 py-1 text-12 text-primary focus:border-accent/60 focus:outline-none";

function formatDay(ms: number, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(
            new Date(ms)
        );
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}

function textOf(t: TFunction, tCount: (key: string, count: number, vars?: any) => string, text: TextOf): string {
    if (text.key === "mc.setup.template.publishes") {
        const targets = String(text.vars?.targets ?? "")
            .split(",")
            .filter((id) => id)
            .map((id) => t(`mc.setup.describe.target.${id}`))
            .join(", ");
        return t(text.key, { targets });
    }
    if (typeof text.vars?.count === "number") {
        return tCount(text.key, text.vars.count, text.vars);
    }
    return t(text.key, text.vars);
}

export type TemplateSave = {
    name: string;
    setName: (name: string) => void;
    keepManual: boolean;
    setKeepManual: (on: boolean) => void;
    keepPublish: boolean;
    setKeepPublish: (on: boolean) => void;
    type: SetupAppType;
    setType: (type: SetupAppType) => void;
    saving: boolean;
    saved: SetupTemplate;
    error: string;
    canSave: boolean;
    save: () => void;
};

// The step's form and its save, held by the stepper so its footer carries "Save the template".
export function useTemplateSave(
    dir: string,
    draft: SetupDraft,
    options: SetupOptions,
    appType: SetupAppType,
    defaultName: string
): TemplateSave {
    const [name, setName] = useState<string>(null);
    const [keepManual, setKeepManual] = useState(true);
    const [keepPublish, setKeepPublish] = useState(true);
    const [type, setType] = useState<SetupAppType>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<SetupTemplate>(null);
    const [error, setError] = useState<string>(null);
    const shownName = name ?? defaultName;
    const shownType = type ?? (appType === "web" ? "other" : appType) ?? "other";
    const canSave = canSaveTemplate(draft, options) && shownName.trim() !== "" && !saving && saved == null;
    const save = () => {
        if (!canSave) {
            return;
        }
        setSaving(true);
        setError(null);
        fireAndForget(async () => {
            try {
                const answer = await setupSaveTemplate(dir, shownName, shownType, options, keepManual, keepPublish);
                setSaved(answer.template);
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setSaving(false);
            }
        });
    };
    const edit =
        <T,>(set: (v: T) => void) =>
        (v: T) => {
            set(v);
            setSaved(null);
        };
    return {
        name: shownName,
        setName: edit(setName),
        keepManual,
        setKeepManual: edit(setKeepManual),
        keepPublish,
        setKeepPublish: edit(setKeepPublish),
        type: shownType,
        setType: edit(setType),
        saving,
        saved,
        error,
        canSave,
        save,
    };
}

export function useDefaultTemplateName(draft: SetupDraft, options: SetupOptions, appType: SetupAppType): string {
    const t = useT();
    if (draft == null || options == null) {
        return "";
    }
    const parts = defaultNameParts(draft, options, appType);
    return t("mc.setup.template.defaultName", { type: t(parts.type), flow: t(parts.flow.key, parts.flow.vars) });
}

function Tick({
    checked,
    disabled,
    onChange,
    label,
    sub,
    testId,
}: {
    checked: boolean;
    disabled?: boolean;
    onChange?: (on: boolean) => void;
    label: string;
    sub?: string;
    testId?: string;
}) {
    return (
        <label
            className={cn(
                "flex items-start gap-2 rounded-4 border px-2.5 py-1.5 text-12 transition-colors duration-120 ease-mt",
                disabled ? "" : "cursor-pointer",
                checked ? "border-accent/60 bg-accent/10" : "border-border hover:border-secondary/40"
            )}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange?.(e.target.checked)}
                className={cn("mt-0.5", disabled ? "" : "cursor-pointer")}
                data-testid={testId}
            />
            <span className="flex min-w-0 flex-col wrap-anywhere">
                <span className="text-primary">{label}</span>
                {sub ? <span className="text-11 text-muted">{sub}</span> : null}
            </span>
        </label>
    );
}

export function TemplateStep({
    draft,
    options,
    projectName,
    form,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    projectName: string;
    form: TemplateSave;
}) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    if (!canSaveTemplate(draft, options)) {
        return (
            <p
                className="rounded-4 border border-warning/40 bg-warning/10 px-3 py-2 text-12 text-secondary"
                data-testid="setup-template-unavailable"
            >
                {options?.kind === "saas" ? t("mc.setup.template.saasLater") : t("mc.setup.template.invalidDraft")}
            </p>
        );
    }
    const flow = flowToSave(draft, options, form.keepManual, form.keepPublish);
    const all = flowToSave(draft, options, true, true);
    const channels: SetupChannel[] = flow.rc === "none" ? ["public"] : ["rc", "public"];
    const blanks = templateBlanks(draft, options);
    const targetNames = all.publish.map((id) => t(`mc.setup.describe.target.${id}`)).join(", ");
    return (
        <div className="flex flex-col gap-3" data-testid="setup-template">
            <div className="grid grid-cols-1 gap-3 @min-[48rem]:grid-cols-2">
                <div className={BlockClass}>
                    <span className={ChipClass}>{t("mc.setup.template.saveTitle")}</span>
                    <p className="text-12 text-secondary">{t("mc.setup.template.saveIntro")}</p>
                    <label className="flex flex-col gap-1 text-12 text-secondary">
                        <span>{t("mc.setup.template.name")}</span>
                        <input
                            value={form.name}
                            maxLength={80}
                            onChange={(e) => form.setName(e.target.value)}
                            className={InputClass}
                            data-testid="setup-template-name"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-12 text-secondary">
                        <span>{t("mc.setup.template.forType")}</span>
                        <select
                            value={form.type}
                            onChange={(e) => form.setType(e.target.value as SetupAppType)}
                            className={cn(InputClass, "cursor-pointer")}
                            data-testid="setup-template-type"
                        >
                            {AppTypes.filter((type) => type !== "web").map((type) => (
                                <option key={type} value={type}>
                                    {t(`mc.setup.appType.${type}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-12 text-secondary">{t("mc.setup.template.kept")}</span>
                        <Tick checked disabled label={t("mc.setup.template.keepFlow")} />
                        <Tick
                            checked={form.keepManual && all.manual.length > 0}
                            disabled={all.manual.length === 0}
                            onChange={form.setKeepManual}
                            label={t("mc.setup.template.keepManual")}
                            sub={
                                all.manual.length === 0
                                    ? t("mc.setup.template.noManual")
                                    : all.manual.map((m) => m.title).join(", ")
                            }
                            testId="setup-template-keep-manual"
                        />
                        <Tick
                            checked={form.keepPublish && all.publish.length > 0}
                            disabled={all.publish.length === 0}
                            onChange={form.setKeepPublish}
                            label={t("mc.setup.template.keepPublish")}
                            sub={
                                all.publish.length === 0
                                    ? t("mc.setup.template.noPublish")
                                    : t("mc.setup.template.keepPublishSub", { targets: targetNames })
                            }
                            testId="setup-template-keep-publish"
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-12 text-secondary">{t("mc.setup.template.blanks")}</span>
                        <div className="flex flex-wrap gap-1" data-testid="setup-template-blanks">
                            {blanks.map((b) => (
                                <span
                                    key={b.key}
                                    className="rounded-4 border border-border px-1.5 py-0.5 font-mono text-11 text-secondary"
                                >
                                    {textOf(t, tCount, b)}
                                </span>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-12 text-secondary">{t("mc.setup.template.where")}</span>
                        <div className="flex items-start gap-2 rounded-4 border border-accent/60 bg-accent/10 px-2.5 py-1.5">
                            <span className="mt-[3px] h-3 w-3 shrink-0 rounded-full border border-accent bg-accent" />
                            <span className="flex min-w-0 flex-col">
                                <span className="text-12 font-medium text-primary">
                                    {t("mc.setup.template.thisComputer")}
                                </span>
                                <span className="text-11 text-muted">{t("mc.setup.template.thisComputerSub")}</span>
                            </span>
                        </div>
                    </div>
                </div>
                <div className={BlockClass}>
                    <span className={ChipClass}>{t("mc.setup.template.previewTitle")}</span>
                    <p className="text-12 text-secondary">{t("mc.setup.template.previewIntro")}</p>
                    {channels.map((c) => (
                        <div key={c} className="flex flex-col gap-1">
                            <div className="text-11 text-muted">{t(`mc.setup.flow.${c}`)}</div>
                            <FlowDiagram model={flowModel(draft, c, options.tagprefix)} />
                        </div>
                    ))}
                    <ul
                        className="flex list-disc flex-col gap-0.5 pl-4 text-12 text-secondary"
                        data-testid="setup-template-summary"
                    >
                        {flowSummary(flow).map((line) => (
                            <li key={line.key}>{textOf(t, tCount, line)}</li>
                        ))}
                        <li>
                            {t("mc.setup.template.fromLine", {
                                project: projectName,
                                date: formatDay(Date.now(), locale),
                            })}
                        </li>
                    </ul>
                </div>
            </div>
            {form.error ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {form.error}
                </p>
            ) : null}
            {form.saved ? (
                <p
                    className="rounded-4 border border-success/40 bg-success/10 px-3 py-2 text-12 text-secondary"
                    role="status"
                    data-testid="setup-template-saved"
                >
                    {t("mc.setup.template.saved", {
                        name: form.saved.name,
                        type: t(`mc.setup.appType.${form.saved.apptype}`),
                    })}
                </p>
            ) : null}
        </div>
    );
}

// The saved templates at the top of step 2b's "Start from" (FR-MC-042); nothing shows while there are none.
export function TemplateChoices({
    fits,
    selected,
    onChoose,
    onForget,
}: {
    fits: SetupTemplateFit[];
    // The template id chosen, "" when another starting point is.
    selected: string;
    onChoose: (fit: SetupTemplateFit) => void;
    onForget: (fit: SetupTemplateFit) => Promise<void>;
}) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    const [confirming, setConfirming] = useState<string>(null);
    const [forgetError, setForgetError] = useState<string>(null);
    if (!(fits?.length > 0)) {
        return null;
    }
    const forget = (fit: SetupTemplateFit) =>
        fireAndForget(async () => {
            try {
                await onForget(fit);
                setConfirming(null);
                setForgetError(null);
            } catch (e) {
                setForgetError(serverErrorText(e));
            }
        });
    return (
        <div className="flex flex-col gap-1.5" data-testid="setup-templates">
            {fits.map((fit) => {
                const tpl = fit.template;
                const on = selected === tpl.id;
                const missing = fit.needs.filter((n) => !n.ok);
                const full = fit.met === fit.total;
                return (
                    <div
                        key={tpl.id}
                        className={cn(
                            "flex flex-col rounded-4 border transition-colors duration-120 ease-mt",
                            on ? "border-accent/60 bg-accent/10" : "border-border hover:border-secondary/40",
                            !fit.sametype && !on && "opacity-60"
                        )}
                    >
                        <button
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => onChoose(fit)}
                            className="flex w-full cursor-pointer items-start gap-2 px-2.5 pt-1.5 pb-1 text-left"
                            data-testid={`setup-template-${tpl.id}`}
                        >
                            <span
                                className={cn(
                                    "mt-[3px] h-3 w-3 shrink-0 rounded-full border",
                                    on ? "border-accent bg-accent" : "border-secondary/60"
                                )}
                            />
                            <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
                                <span className="text-12 font-medium text-primary">
                                    {t("mc.setup.template.pick", { name: tpl.name })}
                                </span>
                                <span className="text-11 text-muted">
                                    {flowSummary(tpl.flow)
                                        .map((line) => textOf(t, tCount, line))
                                        .join(" · ")}
                                </span>
                                {missing.map((need) => {
                                    const text = needText(need);
                                    return (
                                        <span
                                            key={`${need.code}/${need.target ?? ""}`}
                                            className={cn(
                                                "text-11",
                                                need.code === "type" ? "text-warning" : "text-secondary"
                                            )}
                                        >
                                            {t(text.key, {
                                                ...text.vars,
                                                value:
                                                    need.code === "type"
                                                        ? t(`mc.setup.appType.${need.value}`)
                                                        : (text.vars.value as string),
                                                target: need.target ? t(`mc.setup.describe.target.${need.target}`) : "",
                                            })}
                                        </span>
                                    );
                                })}
                                <span className="text-11 text-muted">
                                    {t("mc.setup.template.savedFrom", {
                                        project: tpl.from,
                                        date: formatDay(tpl.savedat, locale),
                                    })}
                                </span>
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 rounded-4 border px-1.5 font-mono text-10",
                                    !fit.sametype
                                        ? "border-error/50 text-danger"
                                        : full
                                          ? "border-success/50 text-success"
                                          : "border-warning/50 text-warning"
                                )}
                                title={t("mc.setup.template.fitTitle", { met: fit.met, total: fit.total })}
                                data-testid="setup-template-fit"
                            >
                                {t("mc.setup.template.fit", { met: fit.met, total: fit.total })}
                            </span>
                        </button>
                        <div className="flex items-center gap-2 px-2.5 pb-1.5 pl-7 text-11">
                            {confirming === tpl.id ? (
                                <>
                                    <span className="text-secondary">{t("mc.setup.template.forgetAsk")}</span>
                                    <button
                                        type="button"
                                        onClick={() => forget(fit)}
                                        className="cursor-pointer rounded-4 border border-error/50 px-1.5 text-danger hover:bg-error/10"
                                        data-testid="setup-template-forget-yes"
                                    >
                                        {t("mc.setup.template.forgetYes")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirming(null)}
                                        className="cursor-pointer text-muted hover:text-primary"
                                    >
                                        {t("common.cancel")}
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setConfirming(tpl.id)}
                                    className="cursor-pointer text-muted hover:text-primary"
                                    data-testid="setup-template-forget"
                                >
                                    {t("mc.setup.template.forget")}
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
            {forgetError ? (
                <p className="text-11 text-danger" role="alert">
                    {forgetError}
                </p>
            ) : null}
        </div>
    );
}
