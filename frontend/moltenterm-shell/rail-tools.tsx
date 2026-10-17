// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tool section of the workspace rail (FR-SHELL-012, DS-SHELL-012): what Wave's right widget bar offered (the user's
// widgets.json widgets, apps, settings), icon-only at the bottom of the rail, so the content gains the bar's width. Apps
// reuse Wave's own flyout, opened to the right of the rail. The add-panel button left the rail with FR-SHELL-042
// (DS-SHELL-068): panels are added where the user works, by splitting one. Since #534 the gear opens Settings itself
// (Secrets is one of its sections) and Tips has its own lightbulb: no menu in between, a second click closes.

import { atoms } from "@/app/store/global";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { AppsFloatingWindow, WidgetsEnv } from "@/app/workspace/widgets";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import {
    autoUpdate,
    FloatingPortal,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useLocale, useT } from "./i18n/i18n";
import { makeViewInActiveTabAtom, toggleMoltentermView } from "./open-view";
import { railCustomWidgets, railWidgetTooltip, splitRailWidgets } from "./rail-tools-model";
import { useListedReviewsAnswer, useReviewsRailWatch } from "./reviews/reviews-client";
import { MoltentermReviewsView, reviewCounts, reviewsRailLabel } from "./reviews/reviews-model";
import { ReviewsRailBadges } from "./reviews/reviews-rail-badge";
import { ReviewsModel } from "./reviews/reviews-store";
import { MoltentermSessionsView, RailBadge } from "./sessions/sessions-model";
import { DurableSessions } from "./sessions/sessions-store";
import { MoltentermTipsView } from "./tips/tips-view";
import { readWorkspaceProject } from "./workspace-project";

export type RailHover = (label: string, anchor: { top: number; left: number }) => void;

const FlyoutPlacement = "right-end";

function openWidget(env: WidgetsEnv, widget: WidgetConfigType) {
    fireAndForget(() => env.createBlock(widget.blockdef, widget.magnified));
}

function ToolButton({
    label,
    onHover,
    onClick,
    buttonRef,
    pressed,
    active,
    children,
}: {
    label: string;
    onHover: RailHover;
    onClick: () => void;
    buttonRef?: (elem: HTMLButtonElement) => void;
    pressed?: boolean;
    // The view the button opens is shown in this tab: the next click closes it.
    active?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            ref={buttonRef}
            type="button"
            aria-label={label}
            aria-expanded={pressed}
            aria-pressed={active}
            onClick={() => {
                onHover(null, null);
                onClick();
            }}
            onMouseEnter={(e) => {
                if (pressed) {
                    return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                onHover(label, { top: rect.top + rect.height / 2, left: rect.right + 8 });
            }}
            onMouseLeave={() => onHover(null, null)}
            className={cn(
                "molten-rail-tool relative flex h-8 w-9 shrink-0 cursor-pointer items-center justify-center rounded-6 text-icon-16 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary",
                pressed && "bg-hover text-primary",
                active &&
                    "bg-hover text-primary before:absolute before:top-2 before:bottom-2 before:-left-1 before:w-0.5 before:rounded-4 before:bg-accent"
            )}
        >
            {children}
        </button>
    );
}

function WidgetIcon({ widget }: { widget: WidgetConfigType }) {
    return (
        <span style={{ color: widget.color }}>
            <i className={makeIconClass(widget.icon, true, { defaultIcon: "browser" })} />
        </span>
    );
}

function OverflowFlyout({
    widgets,
    reference,
    onClose,
    env,
}: {
    widgets: WidgetConfigType[];
    reference: HTMLElement;
    onClose: () => void;
    env: WidgetsEnv;
}) {
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: onClose,
        placement: FlyoutPlacement,
        middleware: [offset(6), shift({ padding: 12 })],
        whileElementsMounted: autoUpdate,
        elements: { reference },
    });
    const { getFloatingProps } = useInteractions([useDismiss(context)]);
    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}
                className="z-50 max-h-[60vh] overflow-y-auto rounded-4 border border-border bg-surface-3 p-1 shadow-command"
            >
                {widgets.map((widget, idx) => (
                    <button
                        key={idx}
                        type="button"
                        title={widget.description || undefined}
                        onClick={() => {
                            onClose();
                            openWidget(env, widget);
                        }}
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-6 px-2.5 py-1.5 text-left text-13 leading-5 text-secondary transition-colors duration-120 ease-mt hover:bg-hoverbg hover:text-primary"
                    >
                        <span className="flex w-5 justify-center">
                            <WidgetIcon widget={widget} />
                        </span>
                        <span className="whitespace-nowrap">{widget.label || railWidgetTooltip(widget)}</span>
                    </button>
                ))}
            </div>
        </FloatingPortal>
    );
}

const BadgeToneClasses: Record<RailBadge["tone"], string> = {
    waiting: "bg-warning text-black",
    error: "bg-error text-white",
    accent: "bg-[var(--mt-state-working)] text-black",
};

// The Sessions view (FR-SHELL-020), with the number of agents running in durable sessions, coloured by the most urgent
// state. The store starts here, so the badge is live in every window.
// A second click closes the view the first one opened (#533).
function SessionsToolButton({ onHover }: { onHover: RailHover }) {
    const badge = useAtomValue(DurableSessions.getInstance().badgeAtom);
    const openBlockId = useAtomValue(makeViewInActiveTabAtom(MoltentermSessionsView));
    return (
        <ToolButton
            label={badge.label}
            onHover={onHover}
            onClick={() => fireAndForget(() => toggleMoltentermView(MoltentermSessionsView))}
            active={openBlockId != null}
        >
            <i className={makeIconClass("layer-group", true)} />
            {badge.count > 0 ? (
                <span
                    className={cn(
                        "absolute top-0.5 right-0.5 min-w-[14px] rounded-full px-[3px] text-center text-11 leading-[14px] font-semibold ring-2 ring-[var(--color-background)]",
                        BadgeToneClasses[badge.tone]
                    )}
                    aria-hidden="true"
                >
                    {badge.count > 99 ? "99+" : badge.count}
                </span>
            ) : null}
        </ToolButton>
    );
}

// The Reviews view (FR-REV-001), with the active project's PRs waiting for review and those ready to merge (#688).
// The rail keeps the counts fresh without the view; the view's own asks feed the same store.
function ReviewsToolButton({ onHover }: { onHover: RailHover }) {
    const workspace = useAtomValue(atoms.workspace);
    const dir = readWorkspaceProject(workspace).dir;
    useReviewsRailWatch(dir);
    const answer = useListedReviewsAnswer(dir);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    useLocale();
    const counts = reviewCounts(answer, readied);
    return (
        <ViewToggleButton
            view={MoltentermReviewsView}
            label={reviewsRailLabel(counts)}
            icon="code-pull-request"
            onHover={onHover}
            open={() => ReviewsModel.getInstance().openReviews()}
        >
            <ReviewsRailBadges counts={counts} />
        </ViewToggleButton>
    );
}

type Flyout = "apps" | "more";

const SettingsView = "waveconfig";

function ViewToggleButton({
    view,
    label,
    icon,
    onHover,
    open,
    children,
}: {
    view: string;
    label: string;
    icon: string;
    onHover: RailHover;
    open: () => Promise<unknown>;
    children?: React.ReactNode;
}) {
    const openBlockId = useAtomValue(makeViewInActiveTabAtom(view));
    return (
        <ToolButton
            label={label}
            onHover={onHover}
            active={openBlockId != null}
            onClick={() => fireAndForget(() => toggleMoltentermView(view, async () => void (await open())))}
        >
            <i className={makeIconClass(icon, true)} />
            {children}
        </ToolButton>
    );
}

export function RailTools({ onHover }: { onHover: RailHover }) {
    const env = useWaveEnv<WidgetsEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const hasConfigErrors = useAtomValue(env.atoms.hasConfigErrors);
    const workspaceId = useAtomValue(env.atoms.workspaceId);
    const t = useT();
    const [open, setOpen] = useState<Flyout>(null);
    const [anchors, setAnchors] = useState<Partial<Record<Flyout, HTMLElement>>>({});

    const showApps = env.isDev() || (fullConfig?.settings?.["feature:waveappbuilder"] ?? false);
    const { shown, overflow } = splitRailWidgets(railCustomWidgets(fullConfig?.widgets, workspaceId));
    const anchorRef = (key: Flyout) => (elem: HTMLButtonElement) => {
        if (elem != null && anchors[key] !== elem) {
            setAnchors((prev) => ({ ...prev, [key]: elem }));
        }
    };
    const toggle = (key: Flyout) => setOpen((prev) => (prev === key ? null : key));
    const close = () => setOpen(null);

    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        env.showContextMenu(
            [
                {
                    label: t("rail.tools.editWidgets"),
                    icon: "pen",
                    click: () =>
                        fireAndForget(() =>
                            env.createBlock({ meta: { view: "waveconfig", file: "widgets.json" } }, false, true)
                        ),
                },
            ],
            e
        );
    };

    return (
        <div
            role="toolbar"
            aria-orientation="vertical"
            aria-label={t("rail.tools.label")}
            onContextMenu={onContextMenu}
            className="molten-rail-tools mt-auto flex w-full shrink-0 flex-col items-center gap-0.5 border-t border-border pt-2"
        >
            <SessionsToolButton onHover={onHover} />
            <ReviewsToolButton onHover={onHover} />
            {shown.map((widget, idx) => (
                <ToolButton
                    key={idx}
                    label={railWidgetTooltip(widget)}
                    onHover={onHover}
                    onClick={() => openWidget(env, widget)}
                >
                    <WidgetIcon widget={widget} />
                </ToolButton>
            ))}
            {overflow.length > 0 ? (
                <ToolButton
                    label={t("rail.tools.moreWidgets", { count: overflow.length })}
                    onHover={onHover}
                    onClick={() => toggle("more")}
                    buttonRef={anchorRef("more")}
                    pressed={open === "more"}
                >
                    <i className={makeIconClass("ellipsis", true)} />
                </ToolButton>
            ) : null}
            {showApps ? (
                <ToolButton
                    label={t("rail.tools.apps")}
                    onHover={onHover}
                    onClick={() => toggle("apps")}
                    buttonRef={anchorRef("apps")}
                    pressed={open === "apps"}
                >
                    <i className={makeIconClass("cube", true)} />
                </ToolButton>
            ) : null}
            <ViewToggleButton
                view={MoltentermTipsView}
                label={t("rail.tools.tips")}
                icon="lightbulb"
                onHover={onHover}
                open={() => env.createBlock({ meta: { view: MoltentermTipsView } }, false, true)}
            />
            <ViewToggleButton
                view={SettingsView}
                label={t(hasConfigErrors ? "rail.tools.settingsErrors" : "rail.tools.settings")}
                icon="gear"
                onHover={onHover}
                open={() => env.createBlock({ meta: { view: SettingsView } }, false, true)}
            >
                {hasConfigErrors ? (
                    <span
                        className="absolute top-1 right-1.5 h-2 w-2 rounded-full bg-error ring-2 ring-[var(--color-background)]"
                        aria-label={t("rail.tools.configErrors")}
                    />
                ) : null}
            </ViewToggleButton>
            {open === "more" && anchors.more ? (
                <OverflowFlyout widgets={overflow} reference={anchors.more} onClose={close} env={env} />
            ) : null}
            {showApps && anchors.apps ? (
                <AppsFloatingWindow
                    isOpen={open === "apps"}
                    onClose={close}
                    referenceElement={anchors.apps}
                    placement={FlyoutPlacement}
                />
            ) : null}
        </div>
    );
}
