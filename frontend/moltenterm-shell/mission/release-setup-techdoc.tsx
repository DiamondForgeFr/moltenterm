// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pipeline's technical documentation among step 3's files and the update's changes (FR-MC-043): where it goes and
// its diff against the current one, built by the backend from the proposed pipeline. Nothing is written here: Write
// and Update rebuild it from the pipeline they carry.

import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openWebLink } from "../open-web-link";
import { DominoLoader } from "../suite/suite";
import { DiffView } from "./release-setup";
import { setupTechDoc } from "./release-setup-client";
import { lineDiff, SetupTechDocPlan } from "./release-setup-model";
import type { PreparedFile } from "./release-setup-prepared-model";

export function techDocCounts(plan: SetupTechDocPlan): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const row of lineDiff(plan?.current ?? "", plan?.proposed ?? "")) {
        if (row.kind === "add") {
            added++;
        } else if (row.kind === "del") {
            removed++;
        }
    }
    return { added, removed };
}

// The document as the pull request would leave it; text "" asks nothing (no valid change to document).
export function useTechDocPlan(
    dir: string,
    text: string,
    kind: "write" | "update"
): { plan: SetupTechDocPlan; error: string } {
    const [plan, setPlan] = useState<SetupTechDocPlan>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        setPlan(null);
        setError(null);
        if (!text) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const answer = await setupTechDoc(dir, text, kind);
                if (!cancelled) {
                    setPlan(answer);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, text, kind]);
    return { plan, error };
}

// Where the document goes: a backend page, the repository file, or the repository file moved from its former path (#1226).
export function techDocWhere(plan: SetupTechDocPlan): { key: string; vars?: Record<string, string> } {
    if (plan.backend !== "repository") {
        return { key: "mc.setup.techdoc.whereBackend" };
    }
    if (plan.movedfrom) {
        return { key: "mc.setup.techdoc.whereMoved", vars: { path: plan.path ?? "", from: plan.movedfrom } };
    }
    return { key: "mc.setup.techdoc.whereRepository", vars: { path: plan.path ?? "" } };
}

// The document as one more generated file of step 3's list (#1104): its diff from the current one, closed at first.
export function techDocFile(plan: SetupTechDocPlan): PreparedFile {
    if (!plan?.proposed) {
        return null;
    }
    const repository = plan.backend === "repository";
    const warning = plan.warnings?.[0];
    return {
        path: repository ? plan.path : plan.title,
        status: plan.current ? "changed" : "new",
        kind: "whole",
        content: plan.proposed,
        before: plan.current,
        collapsed: true,
        introKey: repository ? "mc.setup.techdoc.introRepository" : "mc.setup.techdoc.introBackend",
        warningKey: warning ? "mc.setup.techdoc.fallback" : undefined,
        warningVars: warning ? { reason: warning } : undefined,
    };
}

export function TechDocChanges({ dir, text, kind }: { dir: string; text: string; kind: "write" | "update" }) {
    const t = useT();
    const { plan, error } = useTechDocPlan(dir, text, kind);
    if (!text) {
        return null;
    }
    const counts = techDocCounts(plan);
    return (
        <div className="flex flex-col gap-1.5 rounded-6 border border-border px-3 py-2" data-testid="setup-techdoc">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-12 font-medium text-primary">{t("mc.setup.techdoc.title")}</span>
                {plan?.proposed ? (
                    <span className="rounded-4 border border-border px-1.5 text-11 text-muted">
                        {plan.current ? t("mc.setup.techdoc.updated") : t("mc.setup.techdoc.new")}
                    </span>
                ) : null}
                {plan?.proposed ? (
                    <span className="font-mono text-11 text-muted" data-testid="setup-techdoc-counts">
                        {t("mc.setup.techdoc.lines", { added: counts.added, removed: counts.removed })}
                    </span>
                ) : null}
            </div>
            {plan == null && error == null ? (
                <div className="flex items-center gap-2 text-11 text-muted">
                    <DominoLoader />
                    {t("mc.setup.techdoc.building")}
                </div>
            ) : null}
            {error ? (
                <p className="text-11 text-danger" role="alert">
                    {t("mc.setup.techdoc.error", { error })}
                </p>
            ) : null}
            {plan != null ? (
                <p className="text-11 text-secondary" data-testid="setup-techdoc-where" data-backend={plan.backend}>
                    {t(techDocWhere(plan).key, techDocWhere(plan).vars)}{" "}
                    {kind === "update" ? t("mc.setup.techdoc.whyUpdate") : t("mc.setup.techdoc.why")}
                </p>
            ) : null}
            {plan?.url ? (
                <div>
                    <a
                        href={plan.url}
                        onClick={(e) => {
                            e.preventDefault();
                            fireAndForget(() => openWebLink(plan.url));
                        }}
                        className="inline-flex cursor-pointer items-center gap-1 text-11 text-accent hover:underline"
                    >
                        {t("mc.setup.techdoc.openPage")}
                        <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                    </a>
                </div>
            ) : null}
            {plan?.warnings?.length > 0 ? (
                <ul className="flex flex-col gap-0.5 rounded-4 border border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-secondary">
                    {plan.warnings.map((w) => (
                        <li key={w}>{plan.proposed ? t("mc.setup.techdoc.fallback", { reason: w }) : w}</li>
                    ))}
                </ul>
            ) : null}
            {plan?.proposed ? (
                <details>
                    <summary className="cursor-pointer text-11 text-accent" data-testid="setup-techdoc-show">
                        {t("mc.setup.techdoc.show")}
                    </summary>
                    <div className="mt-1.5">
                        <DiffView before={plan.current} after={plan.proposed} />
                    </div>
                </details>
            ) : null}
        </div>
    );
}
