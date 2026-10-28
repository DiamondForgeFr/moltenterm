// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcut overlay (FR-SHELL-090, DS-SHELL-129): flat key caps over the interface, next to what they act on, a card
// on the focused panel and on the panel under the pointer, and "All shortcuts" to open the full sheet. Loaded on its
// first use by overlay-controller.ts, in a React root of its own.

import { cn } from "@/util/util";
import type React from "react";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n/i18n";
import { prefersReducedMotion } from "../molten-motion";
import type { OverlayController, OverlayMode, OverlayView } from "./overlay-controller";
import { OverlayRootId } from "./overlay-controller";
import { OverlayCapItem, OverlayCard, overlayContent, OverlayRect, staggerDelays } from "./overlay-model";
import { readScreen } from "./overlay-screen";
import "./shortcut-overlay.css";
import { openShortcutsSheet } from "./shortcuts-keys";

// Controls narrower than this get their caps above them (workspace dots, icon buttons); wider ones inside their
// right edge (sidebar rows, the top field).
const NarrowPx = 48;
const EdgePx = 6;
// Below the panel header, so the card never hides the panel's title.
const CardTopPx = 40;

function capPlacement(rect: OverlayRect): React.CSSProperties {
    const cx = rect.left + rect.width / 2;
    if (rect.width < NarrowPx) {
        if (rect.top < 24) {
            return { left: cx, top: rect.top + rect.height + 2, transform: "translate(-50%, 0)" };
        }
        return { left: cx, top: rect.top - 2, transform: "translate(-50%, -100%)" };
    }
    return {
        left: rect.left + rect.width - EdgePx,
        top: rect.top + rect.height / 2,
        transform: "translate(-100%, -50%)",
    };
}

function cardPlacement(card: OverlayCard): React.CSSProperties {
    const r = card.rect;
    if (card.kind === "sidebar") {
        return { left: 12, top: 44 };
    }
    if (card.kind === "hovered") {
        return { left: r.left + r.width / 2, top: r.top + r.height / 2, transform: "translate(-50%, -50%)" };
    }
    return {
        left: r.left + r.width - 12,
        top: r.top + CardTopPx,
        maxHeight: Math.max(r.height - CardTopPx - 12, 60),
        transform: "translate(-100%, 0)",
    };
}

function Caps({ caps, accent }: { caps: string[]; accent?: boolean }) {
    return (
        <span className="inline-flex items-center gap-0.5">
            {caps.map((cap, i) => (
                <kbd key={i} className={cn("mt-sco-key", accent && "is-accent")}>
                    {cap}
                </kbd>
            ))}
        </span>
    );
}

function openSheet(ctl: OverlayController) {
    ctl.close();
    openShortcutsSheet();
}

function CapItem({ item, delay, ctl }: { item: OverlayCapItem; delay: number; ctl: OverlayController }) {
    return (
        <div className="mt-sco-place" style={capPlacement(item.rect)}>
            <button
                type="button"
                className="mt-sco-in mt-sco-cap cursor-pointer"
                style={{ animationDelay: `${delay}ms` }}
                title={item.label}
                aria-label={item.label}
                data-testid="shortcut-overlay-cap"
                data-shortcut={item.shortcutId}
                onClick={() => openSheet(ctl)}
            >
                <Caps caps={item.caps} />
            </button>
        </div>
    );
}

function Card({ card, delay }: { card: OverlayCard; delay: number }) {
    const accent = card.kind === "focused";
    return (
        <div className="mt-sco-place" style={cardPlacement(card)}>
            <div
                className={cn("mt-sco-in mt-sco-card", `is-${card.kind}`)}
                style={{ animationDelay: `${delay}ms` }}
                data-testid="shortcut-overlay-card"
                data-kind={card.kind}
            >
                <div className="mt-sco-card-title">{card.title}</div>
                {card.rows.map((row) => (
                    <div key={row.shortcutId} className="mt-sco-row" data-shortcut={row.shortcutId}>
                        <Caps caps={row.caps} accent={accent} />
                        <span className="mt-sco-label">{row.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ShortcutOverlay({ ctl, mode }: { ctl: OverlayController; mode: OverlayMode }) {
    const content = useMemo(() => overlayContent(readScreen()), []);
    const reduced = useMemo(() => prefersReducedMotion(), []);
    const count = content.cards.length + content.caps.length + 1;
    const delays = staggerDelays(count, reduced);
    return (
        <div
            className={cn("mt-sco", mode === "pinned" && "is-pinned", reduced && "is-reduced")}
            role="dialog"
            aria-label={t("shortcuts.overlay.title")}
            data-testid="shortcut-overlay"
            data-mode={mode}
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                    ctl.close();
                }
            }}
        >
            {content.cards.map((card, i) => (
                <Card key={card.key} card={card} delay={delays[i]} />
            ))}
            {content.caps.map((item, i) => (
                <CapItem key={item.key} item={item} delay={delays[content.cards.length + i]} ctl={ctl} />
            ))}
            <div className="mt-sco-place mt-sco-more-place">
                <button
                    type="button"
                    className="mt-sco-in mt-sco-more cursor-pointer"
                    style={{ animationDelay: `${delays[count - 1]}ms` }}
                    data-testid="shortcut-overlay-more"
                    onClick={() => openSheet(ctl)}
                >
                    {t("shortcuts.overlay.more")}
                </button>
            </div>
        </div>
    );
}

export function mountShortcutOverlay(ctl: OverlayController): OverlayView {
    let container = document.getElementById(OverlayRootId);
    if (container == null) {
        container = document.createElement("div");
        container.id = OverlayRootId;
        document.body.appendChild(container);
    }
    const root = createRoot(container);
    let shown: OverlayMode = "closed";
    let openCount = 0;
    const setMode = (mode: OverlayMode) => {
        if (mode === "closed") {
            shown = mode;
            root.render(null);
            return;
        }
        // Each opening reads the screen again.
        if (shown === "closed") {
            openCount++;
        }
        shown = mode;
        root.render(<ShortcutOverlay key={openCount} ctl={ctl} mode={mode} />);
    };
    return {
        setMode,
        close: () => ctl.close(),
        contains: (node: Node) => container.contains(node),
    };
}
