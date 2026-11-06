// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The avatar's tooltip (FR-BOSS-009, AC1, #2002): what the peek of the bubble told (FR-BOSS-001, AC7), now shown under
// the avatar when the pointer rests on it. A headline, what waits, who works where, the plan usage and the latest
// notification. It is read only and never takes the pointer or the focus, so it leaves with the pointer and typing still
// goes to the terminal.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { createPortal } from "react-dom";
import { GaugeLevel } from "../companion/companion-gauges-model";
import { useT, useTCount } from "../i18n/i18n";
import { Rect, peekPosition } from "./brokk-avatar-model";
import { BossPeek, PeekWaitingRow, usageText, workplaceNames } from "./boss-overview";
import { useCaptionText } from "./brokk-caption";
import type { ScreenCaption } from "./brokk-scene";
import { BossBubbleModel } from "./boss-store";
import { useBrokkScene, useBrokkSituation } from "./use-brokk-live";

const UsageTextColours: Record<GaugeLevel, string> = {
    normal: "text-secondary",
    warning: "text-warning",
    error: "text-danger",
};

function Title({ children }: { children: string }) {
    return <div className="mb-1 text-11 font-semibold tracking-wide text-muted uppercase">{children}</div>;
}

const PeekToneDots: Record<PeekWaitingRow["tone"], string> = {
    error: "bg-error",
    waiting: "bg-accent",
    success: "bg-success",
};

// The headline is the scene's, the sentence the card's header says too (FR-BOSS-007, AC11); the rows are the ones the
// badge counts, hand-off requests and failing CIs included (FR-BOSS-001, AC7).
export function PeekBody({ peek, name, card }: { peek: BossPeek; name: string; card: ScreenCaption }) {
    const t = useT();
    const tCount = useTCount();
    const text = useCaptionText();
    return (
        <div className="flex flex-col gap-2.5 text-12 text-primary">
            <div className="font-semibold">{name}</div>
            <div className="text-secondary" data-testid="boss-peek-headline">
                {text(card.status)}
                {card.detail ? <span data-testid="boss-peek-headline-detail">{` ${text(card.detail)}`}</span> : null}
            </div>
            {peek.waiting.length > 0 ? (
                <div data-testid="boss-peek-waiting">
                    <Title>{t("boss.peek.waitingTitle")}</Title>
                    <ul className="flex flex-col gap-1">
                        {peek.waiting.map((row) => (
                            <li key={row.id} className="flex items-center gap-2" data-tone={row.tone}>
                                <span
                                    aria-hidden
                                    className={cn("inline-block h-2 w-2 shrink-0 rounded-full", PeekToneDots[row.tone])}
                                />
                                <span className="min-w-0 flex-1 truncate">
                                    <span className="font-medium">{row.name}</span>
                                    {row.workspace ? (
                                        <span className="text-secondary">{` · ${row.workspace}`}</span>
                                    ) : null}
                                </span>
                                <span className="max-w-[55%] shrink-0 truncate text-muted">{row.line}</span>
                            </li>
                        ))}
                        {peek.waitingMore > 0 ? (
                            <li className="text-muted">{tCount("boss.peek.more", peek.waitingMore)}</li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {peek.working.length > 0 ? (
                <div data-testid="boss-peek-working">
                    <Title>{t("boss.peek.workingTitle")}</Title>
                    <ul className="flex flex-col gap-1">
                        {peek.working.map((place) => (
                            <li key={place.workspace + place.names.join()} className="flex gap-2">
                                {place.workspace ? (
                                    <span className="max-w-[40%] shrink-0 truncate font-medium">{place.workspace}</span>
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-secondary">{workplaceNames(place)}</span>
                            </li>
                        ))}
                        {peek.workingMore > 0 ? (
                            <li className="text-muted">{tCount("boss.peek.moreWorkspaces", peek.workingMore)}</li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {peek.usage.length > 0 ? (
                <div data-testid="boss-peek-usage">
                    <Title>{t("boss.peek.usageTitle")}</Title>
                    <ul className="flex flex-col gap-1">
                        {peek.usage.map((line) => (
                            <li key={line.agent} className={UsageTextColours[line.level]}>
                                {usageText(line)}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {peek.latest ? (
                <div data-testid="boss-peek-latest">
                    <Title>{t("boss.peek.latestTitle")}</Title>
                    <div className="line-clamp-1 font-medium [overflow-wrap:anywhere]">{peek.latest.title}</div>
                    {peek.latest.message ? (
                        <div className="line-clamp-2 text-secondary [overflow-wrap:anywhere]">
                            {peek.latest.message}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// Drawn only while it shows, so that nothing of it is read at rest. It stands on the page, not in the sidebar: the
// floating sidebar carries a transform, which would carry a fixed tooltip along with it.
export function BrokkTooltip({ id, anchor }: { id: string; anchor: Rect }) {
    const model = BossBubbleModel.getInstance();
    const name = useAtomValue(model.nameAtom, { store: globalStore });
    const peek = useAtomValue(model.peekAtom, { store: globalStore });
    const situation = useBrokkSituation(false, false);
    const scene = useBrokkScene({ pinned: false, peek, situation, speaks: false });
    const place = peekPosition(anchor, { width: window.innerWidth, height: window.innerHeight });
    return createPortal(
        <div
            id={id}
            role="tooltip"
            data-testid="boss-peek"
            className="mt-brokk-tooltip rounded-4 border border-line-strong bg-surface-3 px-3 py-2.5 shadow-e2"
            style={{ top: place.top, left: place.left, width: place.width }}
        >
            <PeekBody peek={peek} name={name} card={scene.card} />
        </div>,
        document.body
    );
}
