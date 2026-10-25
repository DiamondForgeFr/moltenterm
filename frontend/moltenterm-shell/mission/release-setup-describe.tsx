// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2b of the deployment pipeline setup (FR-MC-041): no pipeline yet, the developer describes the one they want. A
// starting point (MoltenTerm's standard pipeline, another linked project as a model, their own words), a few questions
// (branches, where it is published, the release candidates) and a live diagram per channel; the detailed choices stay
// one click away. Nothing is written here: step 3 shows the result, the missing publish workflow included.

import { cn } from "@/util/util";
import { ReactNode } from "react";
import { useT } from "../i18n/i18n";
import {
    branchChoices,
    describeDefaults,
    DescribeFrom,
    RcAnswers,
    sameBranch,
    SetupModel,
    targetRows,
    toggledTarget,
    withRc,
} from "./release-setup-describe-model";
import { BlockClass, ChipClass, Option } from "./release-setup-detect";
import { FlowDiagram } from "./release-setup-diagram";
import { flowModel, SetupChannel, SetupDraft, SetupOptions } from "./release-setup-model";
import type { SetupAppType } from "./release-setup-stepper";
import { TemplateChoices } from "./release-setup-template";
import { orderedFits, SetupTemplateFit } from "./release-setup-template-model";

const SelectClass =
    "w-full max-w-80 cursor-pointer rounded-4 border border-border bg-transparent px-2 py-1 text-12 text-primary focus:border-accent/60 focus:outline-none";
const SameBranch = "\u0000same";

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{label}</span>
            {children}
        </label>
    );
}

function Tick({
    checked,
    onChange,
    label,
    sub,
    testId,
}: {
    checked: boolean;
    onChange: (on: boolean) => void;
    label: string;
    sub?: string;
    testId?: string;
}) {
    return (
        <label
            className={cn(
                "flex cursor-pointer items-start gap-2 rounded-4 border px-2.5 py-1.5 text-12 transition-colors duration-120 ease-mt",
                checked ? "border-accent/60 bg-accent/10" : "border-border hover:border-secondary/40"
            )}
        >
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 cursor-pointer"
                data-testid={testId}
            />
            <span className="flex min-w-0 flex-col wrap-anywhere">
                <span className="font-medium text-primary">{label}</span>
                {sub ? <span className="text-11 text-muted">{sub}</span> : null}
            </span>
        </label>
    );
}

export function DescribeStep({
    draft,
    options,
    from,
    models,
    model,
    words,
    appType,
    templates,
    template,
    onForgetTemplate,
    onChange,
    onFrom,
    onWords,
    children,
    askedTemplate,
    forgotten,
}: {
    // Opened from step 1's "Use a template" (#1106): says so when none is saved yet.
    askedTemplate?: boolean;
    // The name of the template the draft was started from, just forgotten: its choices are kept (#1106).
    forgotten?: string;
    // The templates saved on this computer, checked against this project (FR-MC-042); null while they are read.
    templates?: SetupTemplateFit[];
    template?: string;
    onForgetTemplate?: (fit: SetupTemplateFit) => Promise<void>;
    draft: SetupDraft;
    options: SetupOptions;
    from: DescribeFrom;
    // null while they are read.
    models: SetupModel[];
    model: string;
    words: string;
    appType: SetupAppType;
    onChange: (o: SetupOptions) => void;
    // model: the model project's folder, or the template's id.
    onFrom: (from: DescribeFrom, model?: string) => void;
    onWords: (words: string) => void;
    // The detailed choices of the template.
    children?: ReactNode;
}) {
    const t = useT();
    const branches = branchChoices(draft, options);
    const same = sameBranch(options);
    const rows = targetRows(draft, options);
    const prefix = options.tagprefix || "v";
    const channels: SetupChannel[] = options.rc === "none" ? ["public"] : ["rc", "public"];
    const chosenModel = (models ?? []).find((m) => m.dir === model) ?? (models ?? [])[0];
    const startStandard = () => {
        onFrom("standard");
        onChange(
            describeDefaults(draft, {
                ...draft.defaults,
                trunk: options.trunk,
                release: options.release,
                rc: options.rc,
                publish: options.publish,
            })
        );
    };
    const startModel = (m: SetupModel) => {
        if (m == null) {
            return;
        }
        onFrom("model", m.dir);
        onChange(m.options);
    };
    const startTemplate = (fit: SetupTemplateFit) => {
        onFrom("template", fit.template.id);
        onChange(fit.options);
    };
    const rcSub = (rc: string): string => {
        if (rc === "published") {
            return rows.some((r) => r.id === "npm" && r.on)
                ? t("mc.setup.describe.rc.publishedNpm", { tag: `${prefix}X.Y.Z-1` })
                : t("mc.setup.describe.rc.publishedSub", { tag: `${prefix}X.Y.Z-1` });
        }
        return t(`mc.setup.describe.rc.${rc}Sub`);
    };
    return (
        <div className="flex flex-col gap-3" data-testid="setup-describe">
            <div className={BlockClass} role="radiogroup" aria-label={t("mc.setup.describe.fromTitle")}>
                <span className={ChipClass}>{t("mc.setup.describe.fromTitle")}</span>
                <p className="text-12 text-secondary">{t("mc.setup.describe.fromIntro")}</p>
                {forgotten ? (
                    <p
                        className="rounded-4 border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-11 text-secondary"
                        role="status"
                        data-testid="setup-template-forgotten"
                    >
                        {t("mc.setup.template.forgottenKept", { name: forgotten })}
                    </p>
                ) : null}
                {askedTemplate && !forgotten && templates != null && templates.length === 0 ? (
                    <p
                        className="rounded-4 border border-border bg-hover px-2.5 py-1.5 text-11 text-secondary"
                        data-testid="setup-templates-none"
                    >
                        {t("mc.setup.template.noneSaved")}
                    </p>
                ) : null}
                <TemplateChoices
                    fits={orderedFits(templates)}
                    selected={from === "template" ? template : ""}
                    onChoose={startTemplate}
                    onForget={onForgetTemplate ?? (async () => {})}
                />
                <Option
                    selected={from === "standard"}
                    onSelect={startStandard}
                    label={t("mc.setup.describe.standard", { type: t(`mc.setup.appType.${appType ?? "other"}Short`) })}
                    sub={t("mc.setup.describe.standardSub")}
                    testId="setup-from-standard"
                />
                <div className="flex flex-col gap-1.5">
                    <Option
                        selected={from === "model"}
                        onSelect={() => startModel(chosenModel)}
                        label={t("mc.setup.describe.model")}
                        sub={
                            models == null
                                ? t("mc.setup.describe.modelsReading")
                                : models.length === 0
                                  ? t("mc.setup.describe.noModels")
                                  : t("mc.setup.describe.modelSub")
                        }
                        testId="setup-from-model"
                    />
                    {from === "model" && models?.length > 0 ? (
                        <select
                            value={chosenModel?.dir ?? ""}
                            onChange={(e) => startModel(models.find((m) => m.dir === e.target.value))}
                            className={cn(SelectClass, "ml-5")}
                            aria-label={t("mc.setup.describe.model")}
                            data-testid="setup-model-select"
                        >
                            {models.map((m) => (
                                <option key={m.dir} value={m.dir}>
                                    {t("mc.setup.describe.modelOption", { name: m.name, ref: m.ref })}
                                </option>
                            ))}
                        </select>
                    ) : null}
                </div>
                <Option
                    selected={from === "words"}
                    onSelect={() => onFrom("words")}
                    label={t("mc.setup.describe.words")}
                    sub={t("mc.setup.describe.wordsSub")}
                    testId="setup-from-words"
                />
            </div>
            <div className="grid grid-cols-1 gap-3 @min-[48rem]:grid-cols-2">
                <div className={BlockClass}>
                    <span className={ChipClass}>{t("mc.setup.describe.yourTitle")}</span>
                    <p className="text-12 text-secondary">{t("mc.setup.describe.yourIntro")}</p>
                    <Field label={t("mc.setup.describe.trunk")}>
                        <select
                            value={options.trunk ?? ""}
                            onChange={(e) =>
                                onChange({
                                    ...options,
                                    trunk: e.target.value,
                                    release: same ? e.target.value : options.release,
                                })
                            }
                            className={SelectClass}
                            data-testid="setup-describe-trunk"
                        >
                            {branches.map((b) => (
                                <option key={b} value={b}>
                                    {b}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label={t("mc.setup.describe.release")}>
                        <select
                            value={same ? SameBranch : (options.release ?? "")}
                            onChange={(e) =>
                                onChange({
                                    ...options,
                                    release: e.target.value === SameBranch ? options.trunk : e.target.value,
                                })
                            }
                            className={SelectClass}
                            data-testid="setup-describe-release"
                        >
                            <option value={SameBranch}>
                                {t("mc.setup.describe.sameBranch", { trunk: options.trunk })}
                            </option>
                            {branches
                                .filter((b) => b !== options.trunk)
                                .map((b) => (
                                    <option key={b} value={b}>
                                        {b}
                                    </option>
                                ))}
                        </select>
                    </Field>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-12 text-secondary">{t("mc.setup.describe.where")}</span>
                        {rows.length === 0 ? (
                            <p className="text-11 text-muted">{t("mc.setup.describe.noTarget")}</p>
                        ) : (
                            rows.map((row) => (
                                <Tick
                                    key={row.id}
                                    checked={row.on}
                                    onChange={(on) => onChange(toggledTarget(options, row.id, on))}
                                    label={t(`mc.setup.describe.target.${row.id}`)}
                                    sub={
                                        row.publishedBy
                                            ? t("mc.setup.describe.publishedBy", { file: row.publishedBy })
                                            : row.on
                                              ? t("mc.setup.describe.workflowProposed")
                                              : undefined
                                    }
                                    testId={`setup-target-${row.id}`}
                                />
                            ))
                        )}
                    </div>
                </div>
                <div className={BlockClass}>
                    <span className={ChipClass}>{t("mc.setup.describe.rcTitle")}</span>
                    <p className="text-12 text-secondary">{t("mc.setup.describe.rcIntro")}</p>
                    <div
                        className="flex flex-col gap-1.5"
                        role="radiogroup"
                        aria-label={t("mc.setup.describe.rcTitle")}
                    >
                        {RcAnswers.map((rc) => (
                            <Option
                                key={rc}
                                selected={options.rc === rc}
                                onSelect={() => onChange(withRc(options, rc))}
                                label={t(`mc.setup.describe.rc.${rc}`)}
                                sub={rcSub(rc)}
                                testId={`setup-rc-${rc}`}
                            />
                        ))}
                    </div>
                    <Field label={t("mc.setup.describe.anything")}>
                        <textarea
                            value={words}
                            onChange={(e) => onWords(e.target.value)}
                            rows={3}
                            placeholder={t("mc.setup.describe.anythingPlaceholder")}
                            className="w-full resize-y rounded-4 border border-border bg-transparent px-2 py-1.5 text-12 text-primary placeholder:text-muted focus:border-accent/60 focus:outline-none"
                            autoFocus={from === "words"}
                            data-testid="setup-describe-words"
                        />
                    </Field>
                    {channels.map((c) => (
                        <div key={c} className="flex flex-col gap-1">
                            <div className="text-11 text-muted">{t(`mc.setup.flow.${c}`)}</div>
                            <FlowDiagram model={flowModel(draft, c, prefix)} />
                        </div>
                    ))}
                </div>
            </div>
            {children ? (
                <details className="rounded-6 border border-border px-3 py-2" data-testid="setup-describe-all">
                    <summary className="cursor-pointer text-12 text-primary">
                        {t("mc.setup.describe.allChoices")}
                    </summary>
                    <div className="mt-2">{children}</div>
                </details>
            ) : null}
        </div>
    );
}
