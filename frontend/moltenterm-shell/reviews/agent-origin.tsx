// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What opens says why (#758): the terminal of an agent MoltenTerm started for the developer carries its origin
// (pkg/molten/review/agentstart.go), shown in a slim line above it: "Started by you at 11:21 after merging #736, to
// rebase #737 on develop".

import { useLocale, useT } from "../i18n/i18n";

// must match OriginMetaKey and AgentOrigin in pkg/molten/review/agentstart.go
export const OriginMetaKey = "molten:origin";

export type AgentOrigin = {
    kind: "rebase" | "restart";
    repo: string;
    number: number;
    branch: string;
    base?: string;
    mergedpr?: number;
    round?: number;
    mode: string;
    at: number;
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function readOrigin(value: any): AgentOrigin {
    if (
        value == null ||
        typeof value !== "object" ||
        typeof value.number !== "number" ||
        typeof value.at !== "number"
    ) {
        return null;
    }
    if (value.kind !== "rebase" && value.kind !== "restart") {
        return null;
    }
    return value as AgentOrigin;
}

export function originTime(at: number, locale?: string): string {
    return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function originText(origin: AgentOrigin, translate: Translate, locale?: string): string {
    const vars = {
        time: originTime(origin.at, locale),
        number: origin.number,
        base: origin.base ?? "",
        merged: origin.mergedpr ?? 0,
        round: origin.round ?? 0,
    };
    if (origin.kind === "restart") {
        return translate("agentOrigin.restart", vars);
    }
    if (origin.mergedpr) {
        return translate("agentOrigin.rebaseAfterMerge", vars);
    }
    return translate("agentOrigin.rebase", vars);
}

export function AgentOriginBanner({ value }: { value: any }) {
    const t = useT();
    const locale = useLocale();
    const origin = readOrigin(value);
    if (origin == null) {
        return null;
    }
    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-black/20 px-2.5 py-1 text-11 leading-4 text-secondary"
            data-testid="agent-origin"
            role="note"
        >
            <i className="fa fa-solid fa-circle-info text-10 text-muted" aria-hidden />
            <span className="min-w-0 truncate">{originText(origin, t, locale)}</span>
        </div>
    );
}
