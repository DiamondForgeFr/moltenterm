// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at rest (FR-BOSS-009, AC1, AC2, AC14, AC27, #2002, #2070): a small round animated avatar at the right end of the
// sidebar's title row, which stays on the strip of the collapsed sidebar at the window's edge (smaller, there), or hangs
// from the window's top edge when there is no sidebar. It carries the badge of what
// waits, an animated ring while Brokk himself works (never because other agents do), a small cup while keep-awake holds
// this computer awake and he is closed, and a soft halo while a visit waits for the gate. It shows no hover card: the
// pointer resting on it opens his floating group, unpinned and without the focus, and a click opens it pinned, or pins
// the one the hover opened (AC52 to AC55, #2103). It never opens anything by itself, takes no focus and plays no sound.
// While the scene stands in his place it is hidden; while his group is open it keeps its place and its badge, takes a
// soft ring in the action colour and shows a still frame, so the only animated Brokk is the group's square (#2032).

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { downloadRingOf } from "../downloads/downloads-model";
import { DownloadsModel } from "../downloads/downloads-store";
import { useT } from "../i18n/i18n";
import { useWorkingBeat } from "../working-beat";
import { bubbleLabel } from "./boss-overview";
import { BossPortrait } from "./boss-portrait";
import { BossBubbleModel } from "./boss-store";
import { AvatarVariant, avatarVariant, faceClickAction } from "./brokk-avatar-model";
import "./brokk-avatar.css";
import { AvatarDownloadRing, useDownloadWords } from "./brokk-download-ring";
import { BrokkEdgeModel } from "./brokk-edge-store";
import { BrokkHubModel } from "./brokk-hub-store";
import { brokkMenuItems } from "./brokk-menu";
import { useAvatarBadge, useAvatarLive, useHubSelect } from "./use-brokk-hub";
import { useMotionAllowed } from "./use-brokk-live";

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
    const pinned = useAtomValue(boss.cardPinnedAtom, { store: globalStore });
    const talking = useAtomValue(boss.talkingAtom, { store: globalStore });
    const keepAwake = useAtomValue(boss.keepAwakeAtom, { store: globalStore });
    const ownWorking = useAtomValue(hubModel.ownWorkingAtom, { store: globalStore });
    const badge = useAvatarBadge();
    const cue = useHubSelect((view) => view.cue);
    const sceneUp = useHubSelect((view) => view.visit != null);
    const live = useAvatarLive(ownWorking, sceneUp || cardOpen);
    const unseen = useAtomValue(BrokkEdgeModel.getInstance().unseenAtom, { store: globalStore });
    const running = useAtomValue(DownloadsModel.getInstance().runningAtom, { store: globalStore });
    const downloadRing = downloadRingOf(running);
    const downloadWords = useDownloadWords(running);
    const motion = useMotionAllowed();
    const hover = hubModel.faceHover;

    // The face leaves the page (the scene stands in its place, Brokk turned off): the pointer is no longer on it.
    useEffect(() => () => hover.leaveFace(), [hover]);
    useEffect(() => {
        if (sceneUp) {
            hover.leaveFace();
        }
    }, [hover, sceneUp]);

    // His animated face lives in the group's square while it is open: the avatar keeps a still frame. Its click closes
    // only a pinned group; it pins one the hover opened (AC55).
    const base =
        cardOpen && pinned
            ? t("boss.avatar.close", { name })
            : cue
              ? t("boss.avatar.labelCue", { name, count: badge.count })
              : bubbleLabel(name, badge.count);
    const label = downloadWords != null ? `${base}. ${downloadWords}` : base;
    const onActivate = () => {
        hover.cancel();
        const action = faceClickAction(cardOpen, pinned);
        if (action === "close") {
            boss.closeCard();
            return;
        }
        if (action === "pin") {
            boss.pinCard();
            return;
        }
        hubModel.hub.open();
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        hover.cancel();
        ContextMenuModel.getInstance().showContextMenu(
            brokkMenuItems(name, () => boss.closeCard({ restoreFocus: false }), {
                label: t("boss.menu.openCard", { name }),
                click: () => hubModel.hub.open(),
            }),
            e
        );
    };

    return (
        <button
            type="button"
            className={cn("mt-brokk-avatar", variant === "hanging" && "is-hanging", variant === "edge" && "is-edge")}
            style={style}
            data-testid="brokk-avatar"
            data-boss-anchor=""
            data-brokk-avatar={variant}
            data-working={ownWorking ? "true" : undefined}
            data-cue={cue ? "true" : undefined}
            data-scene={sceneUp ? "up" : undefined}
            data-panel={cardOpen ? "open" : undefined}
            data-news={variant === "edge" && unseen && !motion ? "true" : undefined}
            data-pinned={cardOpen && pinned ? "true" : undefined}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={cardOpen}
            onClick={onActivate}
            onContextMenu={onContextMenu}
            onPointerEnter={(e) => (e.pointerType === "touch" ? undefined : hover.enterFace(e.buttons !== 0))}
            onPointerLeave={() => hover.leaveFace()}
            // A press on the avatar must not move the focus out of the terminal he types in.
            onMouseDown={(e) => e.preventDefault()}
        >
            <span className="mt-brokk-face" aria-hidden>
                <BossPortrait live={live} />
            </span>
            {cardOpen && talking ? (
                <i
                    className={cn(makeIconClass("comment-dots", true), "mt-brokk-talk")}
                    data-testid="brokk-talking"
                    aria-hidden
                />
            ) : null}
            {keepAwake && !cardOpen ? (
                <span className="mt-brokk-cup" data-testid="brokk-cup" aria-hidden>
                    <i className={makeIconClass("mug-hot", true)} />
                </span>
            ) : null}
            {ownWorking ? <AvatarRing /> : null}
            {downloadRing != null ? <AvatarDownloadRing ring={downloadRing} variant={variant} /> : null}
            {cue ? <AvatarHalo /> : null}
            {badge.count > 0 ? (
                <span className="mt-brokk-badge" data-tone={badge.tone} data-testid="boss-badge" aria-hidden>
                    {badge.text}
                </span>
            ) : null}
        </button>
    );
}

// The avatar of the sidebar's title row, while Brokk is not turned off: the row's own when the sidebar is on screen, and
// the strip of the collapsed sidebar, which keeps its row at the window's edge (FR-BOSS-009, AC27, #2070). With no
// sidebar the avatar that hangs from the window's edge stands in, so there is never more than one (AC14).
export function BrokkAvatarSlot() {
    const show = useAtomValue(BossBubbleModel.getInstance().showAtom, { store: globalStore });
    const place = useAtomValue(BrokkHubModel.getInstance().sidebarPlaceAtom, { store: globalStore });
    return show && place !== "none" ? <BrokkAvatar variant={avatarVariant(place)} /> : null;
}
