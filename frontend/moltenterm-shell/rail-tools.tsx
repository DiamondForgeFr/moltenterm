// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tool section of the workspace rail (FR-SHELL-012, DS-SHELL-012): what Wave's right widget bar offered (the user's
// widgets.json widgets, the add-panel button, apps, settings), icon-only at the bottom of the rail, so the content gains
// the bar's width. Apps and settings reuse Wave's own flyouts, opened to the right of the rail.

import { useWaveEnv } from "@/app/waveenv/waveenv";
import { AppsFloatingWindow, SettingsFloatingWindow, WidgetsEnv } from "@/app/workspace/widgets";
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
import { MoltentermAddPanelWidget } from "./add-panel";
import { railCustomWidgets, railWidgetTooltip, splitRailWidgets } from "./rail-tools-model";

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
    children,
}: {
    label: string;
    onHover: RailHover;
    onClick: () => void;
    buttonRef?: (elem: HTMLButtonElement) => void;
    pressed?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            ref={buttonRef}
            type="button"
            aria-label={label}
            aria-expanded={pressed}
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
                "molten-rail-tool relative flex h-8 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-[15px] text-secondary transition-colors hover:bg-hover hover:text-primary",
                pressed && "bg-hover text-primary"
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
                className="z-50 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-modalbg p-1 shadow-xl"
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
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
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

type Flyout = "apps" | "settings" | "more";

export function RailTools({ onHover }: { onHover: RailHover }) {
    const env = useWaveEnv<WidgetsEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const hasConfigErrors = useAtomValue(env.atoms.hasConfigErrors);
    const workspaceId = useAtomValue(env.atoms.workspaceId);
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
                    label: "Edit widgets.json",
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
            aria-label="Tools"
            onContextMenu={onContextMenu}
            className="molten-rail-tools mt-auto flex w-full shrink-0 flex-col items-center gap-0.5 border-t border-border pt-2"
        >
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
                    label={`${overflow.length} more widgets`}
                    onHover={onHover}
                    onClick={() => toggle("more")}
                    buttonRef={anchorRef("more")}
                    pressed={open === "more"}
                >
                    <i className={makeIconClass("ellipsis", true)} />
                </ToolButton>
            ) : null}
            <ToolButton
                label={MoltentermAddPanelWidget.description}
                onHover={onHover}
                onClick={() => openWidget(env, MoltentermAddPanelWidget)}
            >
                <i className={makeIconClass(MoltentermAddPanelWidget.icon, true)} />
            </ToolButton>
            {showApps ? (
                <ToolButton
                    label="Local WaveApps"
                    onHover={onHover}
                    onClick={() => toggle("apps")}
                    buttonRef={anchorRef("apps")}
                    pressed={open === "apps"}
                >
                    <i className={makeIconClass("cube", true)} />
                </ToolButton>
            ) : null}
            <ToolButton
                label={hasConfigErrors ? "Settings & Help · config errors" : "Settings & Help"}
                onHover={onHover}
                onClick={() => toggle("settings")}
                buttonRef={anchorRef("settings")}
                pressed={open === "settings"}
            >
                <i className={makeIconClass("gear", true)} />
                {hasConfigErrors ? (
                    <span
                        className="absolute top-1 right-1.5 h-2 w-2 rounded-full bg-error ring-2 ring-[var(--color-background)]"
                        aria-label="Config errors"
                    />
                ) : null}
            </ToolButton>
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
            {anchors.settings ? (
                <SettingsFloatingWindow
                    isOpen={open === "settings"}
                    onClose={close}
                    referenceElement={anchors.settings}
                    hasConfigErrors={hasConfigErrors}
                    placement={FlyoutPlacement}
                />
            ) : null}
        </div>
    );
}
