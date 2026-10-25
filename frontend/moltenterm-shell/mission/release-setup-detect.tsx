// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 1 of the deployment pipeline setup (FR-MC-038): the app type, detected with its evidence and confirmed, and what
// the repository shows of a pipeline, which recommends analysing it (2a) or describing one (2b).

import { cn } from "@/util/util";
import { useT, useTCount } from "../i18n/i18n";
import type { SetupSource } from "./release-setup-model";
import { AppTypes, SetupAppType, SetupPath, SetupSurvey, SurveyRow, surveyRows } from "./release-setup-stepper";

export const BlockClass = "flex min-w-0 flex-col gap-2 rounded-6 border border-border p-3";
export const ChipClass =
    "self-start rounded-4 border border-border px-1.5 py-0.5 text-10 tracking-wide text-muted uppercase";

const RowMark: Record<SurveyRow["state"], { glyph: string; className: string }> = {
    ok: { glyph: "✓", className: "border-success/50 text-success" },
    half: { glyph: "½", className: "border-warning/50 text-warning" },
    warn: { glyph: "!", className: "border-warning/50 text-warning" },
    none: { glyph: "–", className: "border-border text-muted" },
};

export function Option({
    selected,
    onSelect,
    label,
    sub,
    tag,
    testId,
}: {
    selected: boolean;
    onSelect: () => void;
    label: string;
    sub?: string;
    tag?: string;
    testId?: string;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={onSelect}
            className={cn(
                "flex w-full cursor-pointer items-start gap-2 rounded-4 border px-2.5 py-1.5 text-left transition-colors duration-120 ease-mt",
                selected ? "border-accent/60 bg-accent/10" : "border-border hover:border-secondary/40"
            )}
            data-testid={testId}
        >
            <span
                className={cn(
                    "mt-[3px] h-3 w-3 shrink-0 rounded-full border",
                    selected ? "border-accent bg-accent" : "border-secondary/60"
                )}
            />
            <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
                <span className="text-12 font-medium text-primary">{label}</span>
                {sub ? <span className="text-11 text-muted">{sub}</span> : null}
            </span>
            {tag ? (
                <span className="shrink-0 rounded-4 border border-accent/50 px-1.5 text-10 text-accent">{tag}</span>
            ) : null}
        </button>
    );
}

export function DetectStep({
    survey,
    error,
    pipelineRef,
    appType,
    path,
    onType,
    onPath,
}: {
    survey: SetupSurvey;
    error?: string;
    pipelineRef: string;
    appType: SetupAppType;
    path: SetupPath;
    onType: (t: SetupAppType) => void;
    onPath: (p: SetupPath) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const sourceText = (source: SetupSource) =>
        source?.code
            ? t(`mc.setup.source.${source.code}`, { path: source.path ?? "", detail: source.detail ?? "" })
            : "";
    const detected = survey?.apptype;
    const evidence = (survey?.apptypeevidence ?? []).map(sourceText).filter(Boolean).join(" ");
    const rows = survey ? surveyRows(survey, pipelineRef) : [];
    const recommended = survey?.recommended ?? "analyse";
    return (
        <div className="grid grid-cols-1 gap-3 @min-[48rem]:grid-cols-2" data-testid="setup-detect">
            <div className={BlockClass} role="radiogroup" aria-label={t("mc.setup.detect.typeTitle")}>
                <span className={ChipClass}>{t("mc.setup.detect.typeTitle")}</span>
                <p className="text-12 text-secondary">{t("mc.setup.detect.typeIntro")}</p>
                {AppTypes.map((type) => (
                    <Option
                        key={type}
                        selected={appType === type}
                        onSelect={() => onType(type)}
                        label={t(`mc.setup.appType.${type}`)}
                        sub={type === detected && evidence ? evidence : t(`mc.setup.appType.${type}Hint`)}
                        tag={type === detected && type !== "other" ? t("mc.setup.detect.detected") : undefined}
                        testId={`setup-type-${type}`}
                    />
                ))}
            </div>
            <div className={BlockClass}>
                <span className={ChipClass}>{t("mc.setup.detect.pipelineTitle")}</span>
                <p className="text-12 text-secondary">{t("mc.setup.detect.pipelineIntro")}</p>
                {error ? (
                    <p className="text-12 text-warning" role="alert">
                        {t("mc.setup.detect.unread", { error })}
                    </p>
                ) : null}
                <ul className="flex flex-col gap-1.5" data-testid="setup-detect-rows">
                    {rows.map((row) => (
                        <li key={row.key} className="flex items-start gap-2 text-12">
                            <span
                                className={cn(
                                    "mt-[1px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-4 border text-10",
                                    RowMark[row.state].className
                                )}
                            >
                                {RowMark[row.state].glyph}
                            </span>
                            <span className="flex min-w-0 flex-col wrap-anywhere">
                                <span className={row.state === "none" ? "text-secondary" : "text-primary"}>
                                    {row.count != null
                                        ? tCount(row.labelKey, row.count, row.vars)
                                        : t(row.labelKey, row.vars)}
                                </span>
                                {row.source ? <span className="font-mono text-11 text-muted">{row.source}</span> : null}
                            </span>
                        </li>
                    ))}
                </ul>
                {survey ? (
                    <div
                        className="rounded-4 border border-border bg-hover px-2.5 py-1.5 text-12 text-secondary"
                        data-testid="setup-detect-verdict"
                    >
                        <span className="font-medium text-primary">
                            {survey.ships ? t("mc.setup.detect.ships") : t("mc.setup.detect.noShips")}
                        </span>{" "}
                        {survey.ships ? t("mc.setup.detect.shipsNext") : t("mc.setup.detect.noShipsNext")}
                    </div>
                ) : null}
                <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("mc.setup.detect.pathTitle")}>
                    <Option
                        selected={path === "analyse"}
                        onSelect={() => onPath("analyse")}
                        label={t("mc.setup.detect.analyse")}
                        tag={recommended === "analyse" ? t("mc.setup.detect.recommended") : undefined}
                        testId="setup-path-analyse"
                    />
                    <Option
                        selected={path === "describe"}
                        onSelect={() => onPath("describe")}
                        label={survey?.ships ? t("mc.setup.detect.restart") : t("mc.setup.detect.describe")}
                        sub={survey?.ships ? t("mc.setup.detect.restartHint") : undefined}
                        tag={recommended === "describe" ? t("mc.setup.detect.recommended") : undefined}
                        testId="setup-path-describe"
                    />
                </div>
            </div>
        </div>
    );
}
