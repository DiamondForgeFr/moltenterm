// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at rest (FR-BOSS-009, AC1, AC2, AC14, #2002): a small round animated avatar at the right end of the sidebar's
// title row, or hanging from the window's top edge when the sidebar is not on screen. It carries the badge of what
// waits, an animated ring while Brokk himself works (never because other agents do), and a soft halo while a visit waits
// for the gate. Hovering it shows a tooltip, nothing else; a click opens his panel. It never opens anything by itself,
// takes no focus and plays no sound. While the scene stands in his place it is hidden.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { openSettingsSection } from "../settings/settings-open";
import { useWorkingBeat } from "../working-beat";
import "./brokk-avatar.css";
import { AvatarVariant, PeekDelayMs, Rect } from "./brokk-avatar-model";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkTooltip } from "./brokk-peek";
import { bubbleLabel } from "./boss-overview";
import { BossPortrait } from "./boss-portrait";
import { BossBubbleModel } from "./boss-store";
import { useAvatarBadge, useAvatarLive, useHubSelect } from "./use-brokk-hub";

// The ring is the bell's (notification-center.tsx): a faint track and an arc that takes a quarter turn on each beat of
// the working beat, and stands still when the beat does (reduced motion, a window nobody looks at).
function AvatarRing() {
    useWorkingBeat(true);
    const radius = 13;
    const length = 2 * Math.PI * radius;
    return (
        <svg aria-hidden viewBox="0 0 30 30" className="mt-brokk-ring mt-beat-turn" data-testid="brokk-ring">
            <circle cx="15" cy="15" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
            <circle
                cx="15"
                cy="15"
                r={radius}
                fill="none"
                stroke="var(--mt-action)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={`${0.25 * length} ${length}`}
            />
        </svg>
    );
}

// The soft cue: he has something to tell you, and the gate holds him back. It dims on every other beat of the working
// beat, so that it costs a frame a second, and is a steady halo under reduced motion.
function AvatarHalo() {
    useWorkingBeat(true);
    return <span aria-hidden className="mt-brokk-halo mt-beat-blink" data-testid="brokk-halo" />;
}

export function BrokkAvatar({ variant, style }: { variant: AvatarVariant; style?: React.CSSProperties }) {
    const t = useT();
    const boss = BossBubbleModel.getInstance();
    const hubModel = BrokkHubModel.getInstance();
    const name = useAtomValue(boss.nameAtom, { store: globalStore });
    const cardOpen = useAtomValue(boss.cardOpenAtom, { store: globalStore });
    const ownWorking = useAtomValue(hubModel.ownWorkingAtom, { store: globalStore });
    const badge = useAvatarBadge();
    const cue = useHubSelect((view) => view.cue);
    const sceneUp = useHubSelect((view) => view.visit != null);
    const live = useAvatarLive(ownWorking, sceneUp || cardOpen);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const peekTimer = useRef<ReturnType<typeof setTimeout>>(null);
    const [peek, setPeek] = useState<Rect>(null);
    const tooltipId = useId();

    const closePeek = () => {
        clearTimeout(peekTimer.current);
        setPeek(null);
    };
    const openPeekSoon = () => {
        clearTimeout(peekTimer.current);
        peekTimer.current = setTimeout(() => {
            const box = buttonRef.current?.getBoundingClientRect();
            if (box != null) {
                setPeek({ left: box.left, top: box.top, width: box.width, height: box.height });
            }
        }, PeekDelayMs);
    };
    useEffect(() => () => clearTimeout(peekTimer.current), []);
    // His panel opening, or the scene standing in his place, ends the tooltip.
    useEffect(() => {
        if (cardOpen || sceneUp) {
            closePeek();
        }
    }, [cardOpen, sceneUp]);

    const label = cue ? t("boss.avatar.labelCue", { name, count: badge.count }) : bubbleLabel(name, badge.count);
    const onActivate = () => {
        closePeek();
        if (cardOpen) {
            boss.closeCard();
            return;
        }
        hubModel.hub.open();
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        closePeek();
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: t("boss.menu.openCard", { name }), click: () => hubModel.hub.open() },
                { type: "separator" },
                { label: t("boss.menu.settings", { name }), click: () => void openSettingsSection("boss") },
            ],
            e
        );
    };

    return (
        <button
            ref={buttonRef}
            type="button"
            className={cn("mt-brokk-avatar", variant === "hanging" && "is-hanging")}
            style={style}
            data-testid="brokk-avatar"
            data-boss-anchor=""
            data-brokk-avatar={variant}
            data-working={ownWorking ? "true" : undefined}
            data-cue={cue ? "true" : undefined}
            data-scene={sceneUp ? "up" : undefined}
            data-panel={cardOpen ? "open" : undefined}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={cardOpen}
            aria-describedby={peek != null ? tooltipId : undefined}
            onClick={onActivate}
            onContextMenu={onContextMenu}
            onPointerEnter={(e) => (e.pointerType === "touch" ? undefined : openPeekSoon())}
            onPointerLeave={closePeek}
            onFocus={(e) => (e.currentTarget.matches(":focus-visible") ? openPeekSoon() : undefined)}
            onBlur={closePeek}
            // A press on the avatar must not move the focus out of the terminal he types in.
            onMouseDown={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                if (e.key === "Escape" && peek != null) {
                    e.stopPropagation();
                    closePeek();
                }
            }}
        >
            <span className="mt-brokk-face" aria-hidden>
                <BossPortrait live={live} />
            </span>
            {ownWorking ? <AvatarRing /> : null}
            {cue ? <AvatarHalo /> : null}
            {badge.count > 0 ? (
                <span className="mt-brokk-badge" data-tone={badge.tone} data-testid="boss-badge" aria-hidden>
                    {badge.text}
                </span>
            ) : null}
            {peek != null ? <BrokkTooltip id={tooltipId} anchor={peek} /> : null}
        </button>
    );
}

// The avatar of the sidebar's title row: there while the sidebar is on screen and Brokk is not turned off. Hidden, the
// sidebar waits off the window's edge with its row still in the page; the avatar that hangs from the window's edge
// stands in then, so there is never more than one (FR-BOSS-009, AC14).
export function BrokkAvatarSlot() {
    const show = useAtomValue(BossBubbleModel.getInstance().showAtom, { store: globalStore });
    const onScreen = useAtomValue(BrokkHubModel.getInstance().sidebarOnScreenAtom, { store: globalStore });
    return show && onScreen ? <BrokkAvatar variant="row" /> : null;
}
