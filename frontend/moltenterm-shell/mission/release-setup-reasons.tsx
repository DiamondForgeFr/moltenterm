// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Why the release setup chose its flow (#1046, DS-MC-030): what the release branch's protection asks and how far it
// diverged from the trunk, with the numbers; the one-time reconciliation, and the version labels to keep.

import { cn } from "@/util/util";
import { useT, useTCount } from "../i18n/i18n";
import {
    diverged,
    labelKept,
    rcBranchDisplay,
    reconcilable,
    requiresPr,
    SetupDraft,
    SetupOptions,
    SetupProtection,
    toggledLabel,
} from "./release-setup-model";

function useProtectionText() {
    const t = useT();
    return (p: SetupProtection, rc: string): string => {
        if (p == null) {
            return null;
        }
        if (!p.read) {
            return t("mc.setup.protection.unread", { branch: p.branch, error: p.error ?? "" });
        }
        const rules: string[] = [];
        if (p.pullrequest) {
            rules.push(t("mc.setup.protection.pullRequest"));
        }
        if (p.requiredchecks?.length > 0) {
            rules.push(
                t(p.strict ? "mc.setup.protection.checksStrict" : "mc.setup.protection.checks", {
                    checks: p.requiredchecks.join(", "),
                    branch: p.branch,
                })
            );
        }
        if (p.restrictupdates) {
            rules.push(t("mc.setup.protection.restricted"));
        }
        if (rules.length === 0) {
            return t("mc.setup.protection.none", { branch: p.branch });
        }
        const sources = (p.sources ?? [])
            .map((s) =>
                s.code === "ruleset"
                    ? t("mc.setup.protection.ruleset", { name: s.path ?? "" })
                    : t("mc.setup.protection.classic")
            )
            .join(", ");
        const vars = { branch: p.branch, rules: rules.join(", "), sources, rc };
        if (!requiresPr(p)) {
            return t("mc.setup.protection.bypassable", vars);
        }
        return t(
            p.bypass === "pull_requests_only" ? "mc.setup.protection.requiresPrOnly" : "mc.setup.protection.requires",
            vars
        );
    };
}

function useDivergenceText() {
    const t = useT();
    const tc = useTCount();
    return (draft: SetupDraft, options: SetupOptions): string[] => {
        const d = draft.facts.divergence;
        if (d == null || !d.read) {
            return [];
        }
        const vars = { trunk: d.trunk, release: d.release };
        if (d.ahead === 0) {
            return [t("mc.setup.divergence.none", vars)];
        }
        const lines = [
            tc("mc.setup.divergence.ahead", d.ahead, { ...vars, behind: d.behind }),
            d.conflicts
                ? tc("mc.setup.divergence.conflicts", d.conflictfiles, vars)
                : t("mc.setup.divergence.clean", vars),
        ];
        if (d.notequivalent > 0) {
            lines.push(
                tc("mc.setup.divergence.notEquivalent", d.notequivalent, {
                    ...vars,
                    samples: (d.samples ?? []).join("; "),
                })
            );
        } else if (reconcilable(d)) {
            lines.push(
                t(
                    options.branchmodel === "rcpr"
                        ? "mc.setup.divergence.equivalent"
                        : "mc.setup.divergence.equivalentPromote",
                    vars
                )
            );
        }
        return lines;
    };
}

// FlowReasons: the protection and the divergence, one paragraph each.
export function FlowReasons({ draft, options }: { draft: SetupDraft; options: SetupOptions }) {
    const t = useT();
    const protectionText = useProtectionText();
    const divergenceText = useDivergenceText();
    if (options.kind === "saas" || draft.facts.branches.trunk === draft.facts.branches.release) {
        return null;
    }
    const protection = protectionText(draft.facts.protection, rcBranchDisplay(draft.facts));
    const divergence = divergenceText(draft, options);
    const others: string[] = [];
    const rcOnBranch = (draft.proposal.release?.rc ?? []).some((s) => /--rc-branch/.test(s.run ?? ""));
    if (options.branchmodel === "rcpr" && rcOnBranch) {
        others.push(
            t("mc.setup.why.rcOnBranch", { rc: rcBranchDisplay(draft.facts), release: draft.facts.branches.release })
        );
    }
    if (options.branchmodel === "rcpr") {
        others.push(
            t("mc.setup.why.mergeBack", { release: draft.facts.branches.release, trunk: draft.facts.branches.trunk })
        );
    }
    if (draft.facts.committicket) {
        others.push(t("mc.setup.why.ticket"));
    }
    if (protection == null && divergence.length === 0 && others.length === 0) {
        return null;
    }
    const warn = requiresPr(draft.facts.protection) || diverged(draft.facts.divergence);
    return (
        <div
            className={cn(
                "flex flex-col gap-1 rounded-6 border px-3 py-2 text-12 text-secondary",
                warn ? "border-warning/40 bg-warning/5" : "border-border"
            )}
            data-testid="setup-why"
        >
            <div className="text-12 text-primary">{t("mc.setup.why.title")}</div>
            {protection != null ? <p data-testid="setup-why-protection">{protection}</p> : null}
            {divergence.length > 0 ? <p data-testid="setup-why-divergence">{divergence.join(" ")}</p> : null}
            {others.map((line) => (
                <p key={line}>{line}</p>
            ))}
        </div>
    );
}

// ReconcileCheck offers the merge -s ours when the branches diverged, only where it loses nothing and the pull-request
// flow runs.
export function ReconcileCheck({
    draft,
    options,
    onChange,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onChange: (o: SetupOptions) => void;
}) {
    const t = useT();
    if (options.branchmodel !== "rcpr" || draft.facts.divergence?.notequivalent > 0) {
        return null;
    }
    return (
        <label className="flex cursor-pointer items-start gap-2 text-12 text-primary">
            <input
                type="checkbox"
                className="mt-0.5 cursor-pointer"
                checked={options.reconcile}
                onChange={(e) => onChange({ ...options, reconcile: e.target.checked })}
                data-testid="setup-reconcile"
            />
            <span>
                {t("mc.setup.choices.reconcile", {
                    release: draft.facts.branches.release,
                    rc: rcBranchDisplay(draft.facts),
                })}
                <span className="block text-11 text-muted">{t("mc.setup.choices.reconcileHint")}</span>
            </span>
        </label>
    );
}

// LabelsSection: the version labels found outside the version files, each kept or not.
export function LabelsSection({
    draft,
    options,
    onChange,
    sectionClass,
    titleClass,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onChange: (o: SetupOptions) => void;
    sectionClass: string;
    titleClass: string;
}) {
    const t = useT();
    const labels = draft.facts.labels ?? [];
    if (labels.length === 0) {
        return null;
    }
    return (
        <div className={sectionClass} data-testid="setup-labels">
            <div className={titleClass}>{t("mc.setup.choices.labels")}</div>
            <p className="text-11 text-muted">
                {t("mc.setup.choices.labelsHint", { version: draft.facts.currentversion ?? "" })}
            </p>
            {labels.map((l) => (
                <label key={`${l.path}:${l.line}`} className="flex cursor-pointer items-start gap-2 text-12">
                    <input
                        type="checkbox"
                        className="mt-0.5 cursor-pointer"
                        checked={labelKept(options, l)}
                        onChange={(e) => onChange(toggledLabel(options, l, e.target.checked))}
                    />
                    <span className="min-w-0 flex-1">
                        <span className="font-mono text-11 text-secondary">
                            {l.path}:{l.line}
                        </span>
                        <span className="block truncate font-mono text-11 text-primary">{l.text}</span>
                        {l.pattern ? null : (
                            <span className="block text-11 text-warning">{t("mc.setup.choices.labelManual")}</span>
                        )}
                    </span>
                </label>
            ))}
        </div>
    );
}
