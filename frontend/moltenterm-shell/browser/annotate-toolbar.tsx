// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comment mode's toolbar and list (FR-BRW-017 AC24, DS-BRW-024, #2422): a slim bar floating at the bottom centre of the
// page with the tools, Pause, the count that opens the list, Clear all, Review and send and Close; the question it asks
// when the page changes or when comments would be lost; and the list of every comment. The page under it stays live: the
// layer that holds them takes no pointer but their own (annotate-layer.tsx).

import { cn } from "@/util/util";
import { List, MousePointer2, Pause, Pencil, Play, SquareDashed, Trash2, X } from "lucide-react";
import type { ComponentType } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { excerptOf, MaxZones, sameAddress, type Zone } from "./annotate-model";
import type { MarkKind } from "./annotate-wire";

type IconComponent = ComponentType<{
    size?: number;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
    className?: string;
}>;

export const ToolIcons: Record<MarkKind, IconComponent> = {
    point: MousePointer2,
    zone: SquareDashed,
    freehand: Pencil,
};

const ToolOrder: MarkKind[] = ["point", "zone", "freehand"];

export function NumberBadge({ n }: { n: number }) {
    return (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--mt-action)] text-11 font-semibold text-white">
            {n}
        </span>
    );
}

const IconButton =
    "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-4 text-secondary hover:bg-hover hover:text-primary";

// What the toolbar asks of the developer in place of its tools: to keep or drop the comments of a page that was left, or
// whether to lose every comment on leaving.
export type PageAsk = { count: number; page: string; pages: number };

export type CommentToolbarProps = {
    tool: MarkKind;
    paused: boolean;
    count: number;
    listOpen: boolean;
    leaveAsk: boolean;
    pageAsk: PageAsk;
    onTool: (tool: MarkKind) => void;
    onPause: () => void;
    onList: () => void;
    onClear: () => void;
    onReview: () => void;
    onClose: () => void;
    onDiscard: () => void;
    onKeep: () => void;
    onKeepPage: () => void;
    onDiscardPage: () => void;
};

export function CommentToolbar(props: CommentToolbarProps) {
    const t = useT();
    const tc = useTCount();
    const { count, tool, paused, pageAsk } = props;
    const hint = paused ? t("browser.annotate.hint.paused") : t(`browser.annotate.hint.${tool}`);
    return (
        <div
            className="pointer-events-none absolute inset-x-2 bottom-3 z-30 flex flex-col items-center gap-1.5"
            data-testid="browser-annotate-bar"
        >
            {count === 0 && pageAsk == null && !props.leaveAsk ? (
                <p
                    className="pointer-events-auto rounded-4 border border-border bg-surface-3 px-2.5 py-1 text-11 text-secondary shadow-e2"
                    data-testid="browser-annotate-hint"
                >
                    {hint}
                </p>
            ) : null}
            <div
                className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-4 border border-border bg-surface-3 px-2 py-1.5 text-12 shadow-e2"
                data-testid="browser-annotate-tray"
                role="toolbar"
                aria-label={t("browser.annotate.layerLabel")}
            >
                {pageAsk != null ? (
                    <>
                        <span className="px-1 text-primary" data-testid="browser-annotate-ask">
                            {tc("browser.annotate.ask.title", pageAsk.count, {
                                page:
                                    pageAsk.pages > 1
                                        ? t("browser.annotate.ask.pages", { count: pageAsk.pages })
                                        : pageAsk.page,
                            })}
                        </span>
                        <span className="px-1 text-11 text-muted">{t("browser.annotate.ask.note")}</span>
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            onClick={props.onKeepPage}
                            data-testid="browser-annotate-ask-keep"
                        >
                            {t("browser.annotate.ask.keep")}
                            <MoltenWave />
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={props.onDiscardPage}
                            data-testid="browser-annotate-ask-discard"
                        >
                            {t("browser.annotate.ask.discard")}
                        </button>
                    </>
                ) : props.leaveAsk ? (
                    <>
                        <span className="px-1 text-primary">{tc("browser.annotate.tray.leaveAsk", count)}</span>
                        <button
                            type="button"
                            className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            onClick={props.onDiscard}
                            data-testid="browser-annotate-discard"
                        >
                            {t("browser.annotate.tray.discard")}
                            <MoltenWave />
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={props.onKeep}
                            data-testid="browser-annotate-keep"
                        >
                            {t("browser.annotate.tray.keep")}
                        </button>
                    </>
                ) : (
                    <>
                        <div
                            className="flex items-center gap-0.5"
                            role="group"
                            aria-label={t("browser.annotate.layerLabel")}
                        >
                            {ToolOrder.map((kind) => {
                                const Icon = ToolIcons[kind];
                                const on = kind === tool && !paused;
                                return (
                                    <button
                                        key={kind}
                                        type="button"
                                        className={cn(IconButton, on && "mt-selected-action bg-hover text-primary")}
                                        title={t(`browser.annotate.tool.${kind}`)}
                                        aria-label={t(`browser.annotate.tool.${kind}`)}
                                        aria-pressed={on}
                                        onClick={() => props.onTool(kind)}
                                        data-testid={`browser-annotate-tool-${kind}`}
                                    >
                                        <Icon size={15} strokeWidth={2} aria-hidden />
                                    </button>
                                );
                            })}
                        </div>
                        <span className="h-4 w-px bg-border" aria-hidden />
                        <button
                            type="button"
                            className={cn(IconButton, paused && "bg-hover text-primary")}
                            title={paused ? t("browser.annotate.resume") : t("browser.annotate.pause")}
                            aria-label={paused ? t("browser.annotate.resume") : t("browser.annotate.pause")}
                            aria-pressed={paused}
                            onClick={props.onPause}
                            data-testid="browser-annotate-pause"
                        >
                            {paused ? (
                                <Play size={15} strokeWidth={2} aria-hidden />
                            ) : (
                                <Pause size={15} strokeWidth={2} aria-hidden />
                            )}
                        </button>
                        <span className="h-4 w-px bg-border" aria-hidden />
                        <button
                            type="button"
                            className={cn(
                                "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 font-medium text-primary hover:bg-hover",
                                props.listOpen && "bg-hover"
                            )}
                            title={t("browser.annotate.list.toggle")}
                            aria-label={t("browser.annotate.list.toggle")}
                            aria-expanded={props.listOpen}
                            onClick={props.onList}
                            data-testid="browser-annotate-count"
                        >
                            <List size={14} strokeWidth={2} aria-hidden />
                            {/* A narrow panel keeps the bar on one line: the number alone, the words when there is room. */}
                            <span className="hidden @[560px]:inline">{tc("browser.annotate.tray.zones", count)}</span>
                            <span className="@[560px]:hidden">{count}</span>
                        </button>
                        {count >= MaxZones ? (
                            <span className="text-11 text-muted">
                                {t("browser.annotate.tray.full", { count: MaxZones })}
                            </span>
                        ) : null}
                        {count > 0 ? (
                            <button
                                type="button"
                                className="inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-4 px-1.5 text-12 text-secondary hover:bg-hover hover:text-primary @[560px]:px-2"
                                title={t("browser.annotate.tray.clear")}
                                aria-label={t("browser.annotate.tray.clear")}
                                onClick={props.onClear}
                                data-testid="browser-annotate-clear"
                            >
                                <Trash2 size={14} strokeWidth={2} aria-hidden className="@[560px]:hidden" />
                                <span className="hidden @[560px]:inline">{t("browser.annotate.tray.clear")}</span>
                            </button>
                        ) : null}
                        {count > 0 ? (
                            <button
                                type="button"
                                className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                                onClick={props.onReview}
                                data-testid="browser-annotate-review"
                            >
                                {t("browser.annotate.tray.review")}
                                <MoltenWave />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className={IconButton}
                            title={t("browser.annotate.close")}
                            aria-label={t("browser.annotate.close")}
                            onClick={props.onClose}
                            data-testid="browser-annotate-close"
                        >
                            <X size={15} strokeWidth={2} aria-hidden />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

// What the toolbar shows while the review's pictures are taken: the page scrolls to each mark in turn.
export function CaptureBar({ done, total, onCancel }: { done: number; total: number; onCancel: () => void }) {
    const t = useT();
    return (
        <div
            className="pointer-events-auto absolute inset-x-0 bottom-3 z-30 mx-auto flex w-fit max-w-[calc(100%-1rem)] items-center gap-3 rounded-4 border border-border bg-surface-3 px-3 py-2 text-12 shadow-e2"
            role="status"
            data-testid="browser-annotate-capturing"
        >
            <DominoLoader label={t("browser.annotate.review.capturing", { done, total })} />
            <button
                type="button"
                className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                onClick={onCancel}
                data-testid="browser-annotate-capture-cancel"
            >
                {t("browser.annotate.review.cancel")}
            </button>
        </div>
    );
}

function hostPath(address: string): string {
    try {
        const url = new URL(address);
        return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
        return address;
    }
}

export function pageLabel(address: string): string {
    return hostPath(address);
}

// The list of every comment: a click on one scrolls the page to its mark; those of a page that is no longer shown say so.
export function CommentList({
    zones,
    address,
    editingId,
    onGo,
    onEdit,
    onErase,
}: {
    zones: Zone[];
    address: string;
    editingId: number;
    onGo: (id: number) => void;
    onEdit: (id: number) => void;
    onErase: (id: number) => void;
}) {
    const t = useT();
    return (
        <aside
            className="pointer-events-auto absolute top-2 right-2 z-30 flex max-h-[calc(100%-5.5rem)] w-72 max-w-[calc(100%-1rem)] flex-col rounded-4 border border-border bg-surface-3 shadow-e2"
            aria-label={t("browser.annotate.list.title")}
            data-testid="browser-annotate-list"
        >
            <h3 className="border-b border-border px-3 py-2 text-12 font-semibold text-primary">
                {t("browser.annotate.list.title")}
            </h3>
            {zones.length === 0 ? (
                <p className="px-3 py-3 text-12 text-secondary">{t("browser.annotate.list.empty")}</p>
            ) : (
                <ol className="min-h-0 flex-1 overflow-y-auto py-1">
                    {zones.map((zone, i) => {
                        const here = sameAddress(zone.address, address);
                        const Icon = ToolIcons[zone.kind];
                        const text = excerptOf(zone.comment);
                        return (
                            <li
                                key={zone.id}
                                className={cn("flex items-start gap-1 px-2 py-1", zone.id === editingId && "bg-hover")}
                                data-testid="browser-annotate-list-item"
                                data-n={i + 1}
                            >
                                <button
                                    type="button"
                                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-4 px-1 py-1 text-left hover:bg-hover disabled:cursor-default"
                                    disabled={!here}
                                    title={t("browser.annotate.list.go")}
                                    onClick={() => onGo(zone.id)}
                                    data-testid="browser-annotate-list-go"
                                >
                                    <NumberBadge n={i + 1} />
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span
                                            className={cn(
                                                "flex items-center gap-1 text-12",
                                                text ? "text-primary" : "text-muted"
                                            )}
                                        >
                                            <Icon
                                                size={12}
                                                strokeWidth={2}
                                                aria-hidden
                                                className="shrink-0 text-muted"
                                            />
                                            <span className="min-w-0 truncate">
                                                {text || t("browser.annotate.list.noText")}
                                            </span>
                                        </span>
                                        {here ? null : (
                                            <span className="truncate font-mono text-11 text-muted">
                                                {t("browser.annotate.list.elsewhere", {
                                                    page: pageLabel(zone.address),
                                                })}
                                            </span>
                                        )}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className={IconButton}
                                    title={t("browser.annotate.list.edit")}
                                    aria-label={t("browser.annotate.list.edit")}
                                    onClick={() => onEdit(zone.id)}
                                    data-testid="browser-annotate-list-edit"
                                >
                                    <Pencil size={13} strokeWidth={2} aria-hidden />
                                </button>
                                <button
                                    type="button"
                                    className={IconButton}
                                    title={t("browser.annotate.list.erase")}
                                    aria-label={t("browser.annotate.list.erase")}
                                    onClick={() => onErase(zone.id)}
                                    data-testid="browser-annotate-list-erase"
                                >
                                    <Trash2 size={13} strokeWidth={2} aria-hidden />
                                </button>
                            </li>
                        );
                    })}
                </ol>
            )}
        </aside>
    );
}
