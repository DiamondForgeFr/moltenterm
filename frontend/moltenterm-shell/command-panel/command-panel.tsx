// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command panel of a panel (FR-SHELL-047, DS-SHELL-085): a 360 px popover in the top layer, anchored under the
// header trigger or at the pointer, built on the command palette's matching and keys. Search, suggestions, sections
// in their fixed order, sub-pages instead of cascading submenus, scopes and Reset, and the block actions in the
// footer. The rules live in panel-model.ts; this file renders and wires the keys.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { autoUpdate, flip, offset, Placement, shift, size, useFloating } from "@floating-ui/react";
import { atom, Atom, useAtomValue } from "jotai";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { highlightRuns } from "../palette/palette-model";
import { formatShortcutById } from "../shortcuts/format";
import { splitPanel } from "../split/split";
import { SplitDownIcon, SplitRightIcon } from "../split/split-menu";
import { trackContextMenuPoint } from "./block-menus";
import { CommandPanelModel, OpenCommandPanel, OpenMark, PaintedMeasure } from "./command-panel-store";
import "./command-panel.css";
import { makePanelContext } from "./panel-context";
import {
    activeScope,
    buildRows,
    canReset,
    choiceValueLabel,
    effectiveValue,
    findPage,
    firstSelectable,
    isSelectableRow,
    moveRowSelection,
    nthSelectable,
    numberedIndices,
    openingSelection,
    optionSelected,
    PanelKeyIntent,
    panelKeyIntent,
    PanelMaxHeightPx,
    PanelRow,
    PanelWidthPx,
    resetItem,
    scopeLabel,
    setItemValue,
    stepNumber,
    validStack,
    valueAtScope,
} from "./panel-model";
import { collectPanel } from "./panel-registry";
import {
    PanelAction,
    PanelActionResult,
    PanelChoice,
    PanelChoiceOption,
    PanelContext,
    PanelFeedback,
    PanelFeedbackAction,
    PanelItem,
    PanelNumber,
    PanelScopeId,
    PanelSuggestion,
} from "./panel-types";
import { registerBuiltinCommandProviders } from "./providers";

const ListId = "molten-cmdpanel-list";
const NullAgentAtom = atom(null) as Atom<AgentStateInfo>;
const NullStringAtom = atom(null) as Atom<string>;

// An icon name with Font Awesome modifiers after it ("table-columns fa-rotate-270": Split down's glyph).
function panelIconClass(icon: string): string {
    const [name, ...mods] = (icon ?? "").split(" ");
    const base = makeIconClass(name, true);
    return base == null ? null : cn(base, ...mods);
}

// Ids follow the item, not the position, so a screen reader announces the new selection after a keystroke.
function rowDomId(row: PanelRow): string {
    return row == null ? undefined : `molten-cmdpanel-${row.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

// The value a scoped item shows: what the scope being edited holds, else what it inherits.
function shownValue(item: PanelItem, chosen: PanelScopeId): unknown {
    const binding = activeScope(item as any, chosen);
    return binding != null ? valueAtScope(item as any, binding) : effectiveValue(item as any);
}

// The option's accessible name: its label and value, so a control inside the row is not read instead.
function rowAccessibleName(row: PanelRow, scopes: Record<string, PanelScopeId>, kindLabel: string): string {
    if (row.kind === "heading") {
        return row.title;
    }
    if (row.kind === "option") {
        return row.breadcrumb ? `${row.breadcrumb}: ${row.option.label}` : row.option.label;
    }
    const item = row.item;
    const parts = [item.label];
    if (item.type === "toggle") {
        parts.push(shownValue(item, scopes[item.id]) ? "on" : "off");
    } else if (item.type === "number") {
        const v = Number(shownValue(item, scopes[item.id]));
        parts.push(item.format ? item.format(v) : String(v));
    } else if (item.type === "choice") {
        parts.push(choiceValueLabel(item));
    }
    const binding = activeScope(item as any, scopes[item.id]);
    if (binding != null && (item as any).scopes?.length) {
        parts.push(scopeLabel(binding.scope, kindLabel));
    }
    return parts.filter((p) => p).join(", ");
}

type FooterAction = PanelAction & { refocus?: boolean };

function footerItems(blockId: string, magnified: boolean): FooterAction[] {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(blockId);
    return [
        {
            id: "footer:split-right",
            type: "action",
            label: "Split right",
            icon: SplitRightIcon,
            shortcut: formatShortcutById("split-right"),
            keywords: ["new panel", "add panel"],
            refocus: false,
            run: () => fireAndForget(() => splitPanel(blockId, "right")),
        },
        {
            id: "footer:split-down",
            type: "action",
            label: "Split down",
            icon: SplitDownIcon,
            shortcut: formatShortcutById("split-down"),
            keywords: ["new panel", "add panel"],
            refocus: false,
            run: () => fireAndForget(() => splitPanel(blockId, "down")),
        },
        {
            id: "footer:magnify",
            type: "action",
            label: magnified ? "Unmagnify" : "Magnify",
            icon: magnified ? "compress" : "expand",
            shortcut: formatShortcutById("magnify"),
            keywords: ["zoom", "maximize"],
            run: () => {
                if (node != null) {
                    layoutModel.magnifyNodeToggle(node.id);
                }
            },
        },
        {
            id: "footer:close",
            type: "action",
            label: "Close",
            icon: "xmark",
            destructive: true,
            shortcut: formatShortcutById("close-panel"),
            keywords: ["close panel"],
            refocus: false,
            run: () => uxCloseBlock(blockId),
        },
    ];
}

function Highlighted({ text, indices }: { text: string; indices?: number[] }) {
    if (!indices?.length) {
        return <>{text}</>;
    }
    return (
        <>
            {highlightRuns(text, indices).map((run, i) =>
                run.hit ? (
                    <span key={i} className="text-accent">
                        {run.text}
                    </span>
                ) : (
                    <React.Fragment key={i}>{run.text}</React.Fragment>
                )
            )}
        </>
    );
}

function ItemIcon({ icon, swatch }: { icon?: string; swatch?: string[] }) {
    if (swatch?.length) {
        return (
            <span className="molten-cmdpanel-swatch" aria-hidden>
                {swatch.slice(0, 3).map((c, i) => (
                    <span key={i} style={{ background: c }} />
                ))}
            </span>
        );
    }
    return (
        <span className="flex w-4 shrink-0 items-center justify-center text-icon-14 text-muted" aria-hidden>
            {icon ? <i className={panelIconClass(icon)} /> : null}
        </span>
    );
}

// With several scopes, the badge is the scope switch of an option that has no sub-page (a number, a toggle): a click
// moves the edit to the next scope.
function ScopeBadge({ text, quiet, onNext }: { text: string; quiet?: boolean; onNext?: () => void }) {
    const className = cn(
        "molten-cmdpanel-scope shrink-0 rounded-4 px-1.5 text-11 leading-4 whitespace-nowrap",
        quiet && "is-quiet"
    );
    if (onNext == null) {
        return <span className={className}>{text}</span>;
    }
    return (
        <button
            type="button"
            tabIndex={-1}
            className={cn(className, "cursor-pointer")}
            title={`${text}: click to change where this applies`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
                e.stopPropagation();
                onNext();
            }}
        >
            {text}
        </button>
    );
}

function ResetButton({ label, onReset }: { label: string; onReset: () => void }) {
    return (
        <button
            type="button"
            tabIndex={-1}
            className="molten-cmdpanel-mini cursor-pointer"
            title={`Reset ${label} to its default`}
            aria-label={`Reset ${label} to its default`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
                e.stopPropagation();
                onReset();
            }}
        >
            <i className="fa fa-solid fa-rotate-left" />
        </button>
    );
}

function Switch({ on }: { on: boolean }) {
    return <span className={cn("molten-cmdpanel-switch", on && "is-on")} aria-hidden />;
}

type RowProps = {
    row: PanelRow;
    index: number;
    selected: boolean;
    ctx: PanelContext;
    scopes: Record<string, PanelScopeId>;
    digit: number;
    onHover: (index: number) => void;
    onActivate: (row: PanelRow) => void;
    onReset: (item: PanelItem) => void;
    onNumber: (item: PanelNumber, value: number) => void;
    onScope: (item: PanelItem, scope: PanelScopeId) => void;
    onStep: (item: PanelNumber, delta: number) => void;
    // Values written but not yet back from the store (a stepper pressed fast, a slider dragged).
    pending: Record<string, number>;
    // The awaited item or option running now (an agent command being typed).
    running?: string;
};

function NumberControl({
    item,
    value,
    onNumber,
    onStep,
}: {
    item: PanelNumber;
    value: number;
    onNumber: (item: PanelNumber, value: number) => void;
    onStep: (item: PanelNumber, delta: number) => void;
}) {
    const text = item.format ? item.format(value) : String(value);
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    if (item.control === "slider") {
        return (
            <span className="flex shrink-0 items-center gap-2" onClick={stop}>
                <input
                    type="range"
                    tabIndex={-1}
                    className="molten-cmdpanel-slider cursor-pointer"
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    value={value}
                    aria-label={item.label}
                    aria-valuetext={text}
                    onMouseDown={stop}
                    onChange={(e) => onNumber(item, Number(e.target.value))}
                />
                <span className="w-10 text-right text-11 text-secondary tabular-nums">{text}</span>
            </span>
        );
    }
    return (
        <span className="flex shrink-0 items-center gap-0.5" onClick={stop}>
            <button
                type="button"
                tabIndex={-1}
                className="molten-cmdpanel-mini cursor-pointer"
                aria-label={`Decrease ${item.label}`}
                disabled={value <= item.min}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onStep(item, -1)}
            >
                <i className="fa fa-solid fa-minus" />
            </button>
            <span className="min-w-10 text-center text-12 text-primary tabular-nums">{text}</span>
            <button
                type="button"
                tabIndex={-1}
                className="molten-cmdpanel-mini cursor-pointer"
                aria-label={`Increase ${item.label}`}
                disabled={value >= item.max}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onStep(item, 1)}
            >
                <i className="fa fa-solid fa-plus" />
            </button>
        </span>
    );
}

function RowAside({
    row,
    ctx,
    scopes,
    selected,
    onReset,
    onNumber,
    onScope,
    onStep,
    pending,
}: Omit<RowProps, "index" | "digit" | "onHover" | "onActivate">) {
    if (row.kind === "heading") {
        return null;
    }
    if (row.kind === "option") {
        const selected = optionSelected(row.choice, row.option, scopes[row.choice.id]);
        return selected ? <i className="fa fa-solid fa-check shrink-0 text-icon-14 text-accent" aria-hidden /> : null;
    }
    const item = row.item;
    const chosen = scopes[item.id];
    const binding = activeScope(item as any, chosen);
    // Quiet by default: an option at its default shows no badge; once set, the badge says where and Reset clears that
    // scope only. The sub-page's scope switch names every scope.
    const scoped = binding != null && (item as any).scopes?.length > 0;
    const changed = scoped && canReset(item as any, chosen);
    // The selected row names its scope even at the default, so the keyboard user learns where an edit goes.
    const bindings = (item as any).scopes as { scope: PanelScopeId }[];
    const switchable = scoped && item.type !== "choice" && bindings.length > 1;
    const nextScope = () => {
        const at = bindings.findIndex((b) => b.scope === binding.scope);
        onScope(item, bindings[(at + 1) % bindings.length].scope);
    };
    const badge =
        changed || (scoped && (selected || chosen != null)) ? (
            <ScopeBadge
                text={scopeLabel(binding.scope, ctx.kindLabel)}
                quiet={!changed}
                onNext={switchable ? nextScope : undefined}
            />
        ) : null;
    const reset = changed ? <ResetButton label={item.label} onReset={() => onReset(item)} /> : null;
    switch (item.type) {
        case "toggle": {
            const on = !!(binding != null ? valueAtScope(item, binding) : effectiveValue(item));
            return (
                <>
                    {badge}
                    {reset}
                    <Switch on={on} />
                </>
            );
        }
        case "number": {
            const value =
                pending[item.id] ?? Number(binding != null ? valueAtScope(item, binding) : effectiveValue(item));
            return (
                <>
                    {badge}
                    {reset}
                    <NumberControl item={item} value={value} onNumber={onNumber} onStep={onStep} />
                </>
            );
        }
        case "choice": {
            const label = choiceValueLabel(item);
            return (
                <>
                    {label && <span className="max-w-[40%] min-w-0 truncate text-12 text-secondary">{label}</span>}
                    {badge}
                    {reset}
                    <i className="fa fa-solid fa-chevron-right shrink-0 text-11 text-muted" aria-hidden />
                </>
            );
        }
        case "page":
            return (
                <>
                    {item.valueLabel && (
                        <span className="max-w-[40%] min-w-0 truncate text-12 text-secondary">{item.valueLabel}</span>
                    )}
                    <i className="fa fa-solid fa-chevron-right shrink-0 text-11 text-muted" aria-hidden />
                </>
            );
        default:
            return item.shortcut ? (
                <span className="shrink-0 font-mono text-11 text-muted">{item.shortcut}</span>
            ) : null;
    }
}

function PanelRowView(props: RowProps) {
    const { row, index, selected, digit, onHover, onActivate } = props;
    if (row.kind === "heading") {
        return null;
    }
    const isOption = row.kind === "option";
    const label = isOption ? row.option.label : row.item.label;
    const icon = isOption ? row.option.icon : row.item.icon;
    const swatch = isOption ? row.option.swatch : null;
    const detail = isOption ? row.option.detail : row.item.detail;
    const disabled = !isSelectableRow(row);
    const destructive = !isOption && row.item.destructive;
    const isInfo = !isOption && row.item.type === "info";
    const checked = isOption
        ? optionSelected(row.choice, row.option, props.scopes[row.choice.id])
        : row.item.type === "toggle"
          ? !!shownValue(row.item, props.scopes[row.item.id])
          : undefined;
    if (isInfo) {
        return (
            <div className="px-3 pt-1.5 pb-0.5 text-11 text-muted" role="presentation">
                {label}
            </div>
        );
    }
    const title = !isOption && row.item.disabledReason ? row.item.disabledReason : undefined;
    return (
        <div
            id={rowDomId(row)}
            role="option"
            aria-label={rowAccessibleName(row, props.scopes, props.ctx?.kindLabel)}
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            aria-checked={checked}
            data-index={index}
            data-item={isOption ? row.option.id : row.item.id}
            title={title}
            onMouseMove={() => !disabled && onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => !disabled && onActivate(row)}
            className={cn(
                "mx-1 flex h-row items-center gap-2 rounded-6 px-2 text-12",
                disabled ? "cursor-default opacity-45" : "cursor-pointer",
                selected ? "molten-palette-selected text-primary" : "text-secondary",
                destructive && "text-danger"
            )}
        >
            <ItemIcon icon={icon} swatch={swatch} />
            <span className="min-w-0 flex-1 truncate">
                <Highlighted text={label} indices={row.indices} />
                {row.breadcrumb && <span className="ml-1.5 text-11 text-muted">{row.breadcrumb}</span>}
                {detail && !row.breadcrumb && <span className="ml-1.5 text-11 text-muted">{detail}</span>}
            </span>
            {props.running != null && props.running === (isOption ? row.option.id : row.item.id) ? (
                <i className="fa fa-solid fa-circle-notch fa-spin shrink-0 text-11 text-muted" aria-label="Sending" />
            ) : digit > 0 ? (
                <span className="shrink-0 font-mono text-11 text-secondary">⌘{digit}</span>
            ) : (
                <RowAside {...props} />
            )}
        </div>
    );
}

function Suggestions({ items, onRun }: { items: PanelSuggestion[]; onRun: (s: PanelSuggestion) => void }) {
    if (!items?.length) {
        return null;
    }
    return (
        <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2" role="group" aria-label="Suggestions">
            {items.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    className={cn(
                        "molten-cmdpanel-chip flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-6 px-2 text-11 font-medium",
                        s.tone === "warning" ? "is-warning" : "is-accent"
                    )}
                    title={s.action ? `${s.label} (${s.action})` : undefined}
                    aria-label={s.action ? `${s.label}. ${s.action}` : undefined}
                    onClick={() => onRun(s)}
                >
                    {s.icon && <i className={cn(panelIconClass(s.icon), "shrink-0")} aria-hidden />}
                    <span className="min-w-0 truncate">{s.label}</span>
                    {s.action && <span className="molten-cmdpanel-chip-verb shrink-0 font-semibold">{s.action}</span>}
                </button>
            ))}
        </div>
    );
}

type FeedbackProps = {
    feedback: PanelFeedback;
    running: string;
    onAction: (action: PanelFeedbackAction) => void;
};

// A refusal or a confirmation in place of the suggestions (FR-SHELL-048): it says why nothing was typed and offers
// what fits. A confirmation takes the focus on its first action (Cancel), so Enter never clears a draft by accident.
function Feedback({ feedback, running, onAction }: FeedbackProps) {
    const firstRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (feedback.role === "alertdialog") {
            firstRef.current?.focus({ preventScroll: true });
        }
    }, [feedback.id, feedback.role]);
    const messageId = `molten-cmdpanel-feedback-${feedback.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    return (
        <div
            className={cn("molten-cmdpanel-feedback border-b border-line px-3 py-2", `is-${feedback.tone ?? "muted"}`)}
            role={feedback.role ?? "status"}
            aria-live={feedback.role === "alertdialog" ? undefined : "polite"}
            aria-describedby={feedback.role === "alertdialog" ? messageId : undefined}
            aria-label={feedback.role === "alertdialog" ? "Confirm" : undefined}
        >
            <div id={messageId} className="molten-cmdpanel-feedback-text text-12 leading-5">
                {feedback.message}
            </div>
            {feedback.actions?.length > 0 && (
                <div className="mt-1.5 flex justify-end gap-1.5">
                    {feedback.actions.map((action, i) => (
                        <button
                            key={action.id}
                            ref={i === 0 ? firstRef : undefined}
                            type="button"
                            disabled={running != null}
                            className={cn(
                                "h-6 cursor-pointer rounded-6 px-2 text-11 font-medium",
                                action.primary
                                    ? "molten-cmdpanel-feedback-primary"
                                    : "molten-cmdpanel-feedback-secondary"
                            )}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => onAction(action)}
                        >
                            {running === action.id ? "…" : action.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

type PageHeaderProps = {
    page: PanelItem;
    ctx: PanelContext;
    scope: PanelScopeId;
    onBack: () => void;
    onScope: (scope: PanelScopeId) => void;
    onReset: () => void;
};

function PageHeader({ page, ctx, scope, onBack, onScope, onReset }: PageHeaderProps) {
    const scoped = (page as PanelChoice).scopes ?? [];
    const binding = scoped.length ? activeScope(page as PanelChoice, scope) : null;
    return (
        <div className="border-b border-line px-1 pt-1 pb-1">
            <div className="flex h-row items-center gap-1">
                <button
                    type="button"
                    className="molten-cmdpanel-back flex h-6 cursor-pointer items-center gap-1.5 rounded-6 px-1.5 text-12 font-medium text-primary"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onBack}
                    aria-label={`Back from ${page.label}`}
                    title="Back (←)"
                >
                    <i className="fa fa-solid fa-chevron-left text-11 text-muted" aria-hidden />
                    {page.label}
                </button>
                <span className="ml-auto" />
                {binding != null && canReset(page as PanelChoice, scope) && (
                    <button
                        type="button"
                        className="molten-cmdpanel-back flex h-6 cursor-pointer items-center gap-1 rounded-6 px-1.5 text-11 text-secondary"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={onReset}
                    >
                        <i className="fa fa-solid fa-rotate-left" aria-hidden />
                        Reset
                    </button>
                )}
            </div>
            {scoped.length > 1 && (
                <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-1">
                    <span className="text-11 text-muted">Applies to</span>
                    <div
                        className="molten-cmdpanel-segmented flex rounded-6 p-0.5"
                        role="radiogroup"
                        aria-label="Scope"
                    >
                        {scoped.map((b) => (
                            <button
                                key={b.scope}
                                type="button"
                                role="radio"
                                aria-checked={binding?.scope === b.scope}
                                className={cn(
                                    "h-6 cursor-pointer rounded-4 px-2 text-11",
                                    binding?.scope === b.scope ? "is-active text-primary" : "text-secondary"
                                )}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => onScope(b.scope)}
                            >
                                {scopeLabel(b.scope, ctx.kindLabel)}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function useModifierKeys() {
    const [alt, setAlt] = useState(false);
    const [meta, setMeta] = useState(false);
    useEffect(() => {
        const update = (e: KeyboardEvent) => {
            setAlt(e.altKey);
            setMeta(isMacOS() ? e.metaKey : e.ctrlKey);
        };
        const reset = () => {
            setAlt(false);
            setMeta(false);
        };
        window.addEventListener("keydown", update, true);
        window.addEventListener("keyup", update, true);
        window.addEventListener("blur", reset);
        return () => {
            window.removeEventListener("keydown", update, true);
            window.removeEventListener("keyup", update, true);
            window.removeEventListener("blur", reset);
        };
    }, []);
    return { alt, meta };
}

function placementFor(open: OpenCommandPanel): Placement {
    return open.anchor.kind === "point" ? "bottom-start" : "bottom-end";
}

type CommandPanelProps = { open: OpenCommandPanel };

function CommandPanel({ open }: CommandPanelProps) {
    const model = CommandPanelModel.getInstance();
    const blockId = open.blockId;
    const block = useAtomValue(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const agent = useAtomValue(blockId ? AgentStates.getInstance().blockAtom(blockId) : NullAgentAtom);
    const layoutModel = getLayoutModelForStaticTab();
    const magnifiedNodeId = useAtomValue(layoutModel?.magnifiedNodeIdAtom ?? NullStringAtom);
    const [tick, setTick] = useState(0);
    const [query, setQuery] = useState(open.query ?? "");
    const [stack, setStack] = useState<string[]>([]);
    const [direction, setDirection] = useState<"in" | "back">("in");
    const [selected, setSelected] = useState(-1);
    const [scopes, setScopes] = useState<Record<string, PanelScopeId>>({});
    const [pending, setPending] = useState<Record<string, number>>({});
    const [feedback, setFeedback] = useState<PanelFeedback>(null);
    // The item or feedback action waiting for its result: the panel stays open and runs nothing else meanwhile.
    const [running, setRunning] = useState<string>(null);
    const runningRef = useRef<string>(null);
    const sources = useAtomValue(model.sourcesAtom);
    // Mirrors pending for steps fired before React renders again (clicks in one task, key auto-repeat).
    const pendingRef = useRef<Record<string, number>>({});
    const [lockedPlacement, setLockedPlacement] = useState<Placement>(null);
    const { alt, meta } = useModifierKeys();
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const armed = useRef(open.source !== "header");
    const numberTimer = useRef<ReturnType<typeof setTimeout>>(null);
    const numberPending = useRef<{ item: PanelNumber; value: number; chosen: PanelScopeId }>(null);
    const lastNumberWrite = useRef(0);
    const bumpTimer = useRef<ReturnType<typeof setTimeout>>(null);

    // Writes are async: the panel reads its sources again when they land, and once more a moment later for the
    // items whose state Wave keeps outside the stores.
    const bump = useCallback(() => {
        setTick((t) => t + 1);
        if (bumpTimer.current) {
            clearTimeout(bumpTimer.current);
        }
        bumpTimer.current = setTimeout(() => setTick((t) => t + 1), 180);
    }, []);
    useEffect(
        () => () => {
            if (bumpTimer.current) {
                clearTimeout(bumpTimer.current);
            }
            if (numberTimer.current) {
                clearTimeout(numberTimer.current);
            }
        },
        []
    );

    const ctx = useMemo(() => makePanelContext(blockId), [blockId, block, fullConfig, agent, tick, sources]);
    const collected = useMemo(() => (ctx ? collectPanel(ctx) : { sections: [], suggestions: [] }), [ctx]);
    const node = layoutModel?.getNodeByBlockId(blockId);
    const magnified = node != null && magnifiedNodeId === node.id;
    const footer = useMemo(() => footerItems(blockId, magnified), [blockId, magnified]);
    const liveStack = useMemo(() => validStack(collected.sections, stack), [collected, stack]);
    const page = liveStack.length > 0 ? findPage(collected.sections, liveStack) : null;
    const rows = useMemo(
        () => buildRows({ sections: collected.sections, stack: liveStack, query, alt, footer }),
        [collected, liveStack, query, alt, footer]
    );
    const hasDeveloper = collected.sections.some((s) => s.kind === "developer");
    const hasOwnSections = collected.sections.some((s) => s.kind !== "developer");

    useEffect(() => {
        if (block == null) {
            model.close(false);
        }
    }, [block]);
    useEffect(() => {
        const unsubscribe = globalStore.sub(atoms.workspaceId, () => model.close(false));
        return unsubscribe;
    }, []);
    // The selection follows the item, not the position: when the panel reads its sources again and an item appears or
    // goes, Enter still runs the item that was highlighted.
    const selectedKey = useRef<string>(null);
    useEffect(() => {
        if (rows[selected] != null) {
            selectedKey.current = rows[selected].key;
        }
    }, [selected]);
    const pageKey = `${query}\u0000${liveStack.join("/")}`;
    const lastPageKey = useRef(pageKey);
    useEffect(() => {
        if (lastPageKey.current !== pageKey) {
            lastPageKey.current = pageKey;
            selectedKey.current = null;
            setSelected(query === "" && liveStack.length > 0 ? openingSelection(rows, scopes) : firstSelectable(rows));
            return;
        }
        const kept = rows.findIndex((r) => r.key === selectedKey.current);
        if (kept >= 0 && isSelectableRow(rows[kept])) {
            if (kept !== selected) {
                setSelected(kept);
            }
            return;
        }
        if (selected >= 0 && rows[selected] != null && isSelectableRow(rows[selected])) {
            return;
        }
        setSelected(firstSelectable(rows));
    }, [rows, pageKey]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);
    const { refs, floatingStyles, isPositioned, placement } = useFloating({
        open: true,
        placement: lockedPlacement ?? placementFor(open),
        strategy: "fixed",
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(open.anchor.kind === "point" ? 2 : 4),
            // The side is chosen once, at open: a sub-page changing the height must not flip the panel.
            lockedPlacement == null && flip({ padding: 8 }),
            shift({ padding: 8, crossAxis: true }),
            size({
                padding: 8,
                apply({ availableHeight, elements }) {
                    const max = Math.min(PanelMaxHeightPx, Math.floor(window.innerHeight * 0.8), availableHeight);
                    elements.floating.style.maxHeight = `${Math.max(160, max)}px`;
                },
            }),
        ],
    });
    useLayoutEffect(() => {
        const a = open.anchor;
        const rect =
            a.kind === "point"
                ? { x: a.x, y: a.y, left: a.x, top: a.y, right: a.x, bottom: a.y, width: 0, height: 0 }
                : {
                      x: a.left,
                      y: a.top,
                      left: a.left,
                      top: a.top,
                      right: a.right,
                      bottom: a.bottom,
                      width: a.right - a.left,
                      height: a.bottom - a.top,
                  };
        refs.setPositionReference({ getBoundingClientRect: () => ({ ...rect, toJSON: () => rect }) });
    }, [open.anchor, refs]);
    // A hidden element cannot take the focus, and the layer becomes a shown popover only after this panel's effects:
    // the search takes the focus once it can, and again on each page.
    useLayoutEffect(() => {
        if (!isPositioned) {
            return;
        }
        let tries = 0;
        let frame = 0;
        const focus = () => {
            const input = inputRef.current;
            if (input == null) {
                return;
            }
            input.focus({ preventScroll: true });
            if (document.activeElement !== input && tries++ < 10) {
                frame = requestAnimationFrame(focus);
            }
        };
        focus();
        return () => cancelAnimationFrame(frame);
    }, [isPositioned, liveStack.length]);
    // The focus stays in the panel while it is open (NFR-SHELL-026): the header's click handlers give the focus back
    // to the trigger or the terminal after the panel opened.
    useEffect(() => {
        const keep = (e: FocusEvent) => {
            const panel = panelRef.current;
            // Closing gives the focus back to the panel it came from: the trap lets go as soon as the panel closes.
            if (panel == null || model.current()?.token !== open.token || panel.contains(e.target as Node)) {
                return;
            }
            inputRef.current?.focus({ preventScroll: true });
        };
        // A webview or the menu layer can take the focus without a focusin here: when the panel loses it, it takes it
        // back on the next frame unless it closed meanwhile.
        let frame = 0;
        const lost = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const panel = panelRef.current;
                if (panel == null || model.current()?.token !== open.token || panel.contains(document.activeElement)) {
                    return;
                }
                inputRef.current?.focus({ preventScroll: true });
            });
        };
        const panel = panelRef.current;
        document.addEventListener("focusin", keep, true);
        panel?.addEventListener("focusout", lost);
        window.addEventListener("blur", lost);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("focusin", keep, true);
            panel?.removeEventListener("focusout", lost);
            window.removeEventListener("blur", lost);
        };
    }, []);
    useEffect(() => {
        if (!isPositioned || lockedPlacement != null) {
            return;
        }
        setLockedPlacement(placement);
        // NFR-SHELL-028: from the trigger to the frame that paints the positioned panel.
        requestAnimationFrame(() => {
            try {
                performance.measure(PaintedMeasure, OpenMark);
            } catch {
                /* the mark can be missing (a test, a cleared buffer) */
            }
        });
    }, [isPositioned]);

    const closePanel = (refocus = true) => model.close(refocus);

    // What an awaited action answered: close, take the feedback away, or show it.
    const applyResult = (result: PanelActionResult, closeOnNothing: boolean) => {
        if (result === "close" || (result == null && closeOnNothing)) {
            closePanel();
            return;
        }
        if (result === "dismiss") {
            setFeedback(null);
            // The button that had the focus goes with the feedback: the search takes it back.
            inputRef.current?.focus({ preventScroll: true });
            return;
        }
        if (result != null && typeof result === "object") {
            setFeedback(result);
            return;
        }
        bump();
    };

    const runAwaited = (key: string, run: () => unknown, closeOnNothing: boolean) => {
        if (runningRef.current != null) {
            return;
        }
        runningRef.current = key;
        setRunning(key);
        fireAndForget(async () => {
            try {
                const result = (await run()) as PanelActionResult;
                applyResult(result, closeOnNothing);
            } finally {
                runningRef.current = null;
                setRunning(null);
            }
        });
    };

    const runFeedbackAction = (action: PanelFeedbackAction) => runAwaited(action.id, action.run, true);

    const runAction = (item: PanelAction) => {
        if (item.disabled) {
            return;
        }
        if (item.awaitResult) {
            setFeedback(null);
            runAwaited(item.id, item.run, true);
            return;
        }
        if (item.keepOpen) {
            fireAndForget(async () => {
                await item.run();
                bump();
            });
            return;
        }
        closePanel((item as FooterAction).refocus !== false);
        fireAndForget(async () => item.run());
    };

    const chooseOption = (choice: PanelChoice, option: PanelChoiceOption) => {
        if (option.disabled) {
            return;
        }
        if (option.run != null && choice.awaitResult) {
            setFeedback(null);
            runAwaited(option.id, option.run, false);
            return;
        }
        fireAndForget(async () => {
            if (option.run != null) {
                await option.run();
            } else {
                await setItemValue(choice, option.value, scopes[choice.id]);
            }
            bump();
        });
    };

    const openPage = (path: string[], item: PanelItem) => {
        setFeedback(null);
        setDirection("in");
        setStack([...path, item.id]);
        setQuery("");
    };

    const back = () => {
        if (liveStack.length === 0) {
            return;
        }
        setFeedback(null);
        setDirection("back");
        setStack(liveStack.slice(0, -1));
        setQuery("");
    };

    const activate = (row: PanelRow) => {
        if (row == null || row.kind === "heading" || !isSelectableRow(row)) {
            return;
        }
        if (row.kind === "option") {
            chooseOption(row.choice, row.option);
            return;
        }
        const item = row.item;
        switch (item.type) {
            case "action":
                runAction(item);
                return;
            case "toggle": {
                const binding = activeScope(item, scopes[item.id]);
                const current = binding != null ? valueAtScope(item, binding) : effectiveValue(item);
                fireAndForget(async () => {
                    await setItemValue(item, !current, scopes[item.id]);
                    bump();
                });
                return;
            }
            case "choice":
            case "page":
                openPage(row.path, item);
                return;
            case "number":
                return;
        }
    };

    const writeNumber = (item: PanelNumber, value: number, chosen: PanelScopeId) => {
        lastNumberWrite.current = Date.now();
        fireAndForget(async () => {
            await setItemValue(item, value, chosen);
            bump();
            // The store's copy arrives with the object update: keep showing the written value until then.
            setTimeout(() => {
                if (pendingRef.current[item.id] !== value) {
                    return;
                }
                const rest = { ...pendingRef.current };
                delete rest[item.id];
                pendingRef.current = rest;
                setPending(rest);
            }, 400);
        });
    };

    // The value the next step starts from: the one just written, else the store's.
    const numberValue = (item: PanelNumber): number => {
        if (pendingRef.current[item.id] != null) {
            return pendingRef.current[item.id];
        }
        const binding = activeScope(item, scopes[item.id]);
        return Number(binding != null ? valueAtScope(item, binding) : effectiveValue(item));
    };

    // A slider drags through many values: the panel writes at most every 60 ms while it moves, and always the last
    // value (leading and trailing throttle).
    const onNumber = (item: PanelNumber, value: number) => {
        const chosen = scopes[item.id];
        pendingRef.current = { ...pendingRef.current, [item.id]: value };
        setPending(pendingRef.current);
        const wait = item.control === "slider" ? 60 - (Date.now() - lastNumberWrite.current) : 0;
        if (wait <= 0) {
            if (numberTimer.current) {
                clearTimeout(numberTimer.current);
                numberTimer.current = null;
            }
            writeNumber(item, value, chosen);
            return;
        }
        numberPending.current = { item, value, chosen };
        if (numberTimer.current) {
            return;
        }
        numberTimer.current = setTimeout(() => {
            numberTimer.current = null;
            const next = numberPending.current;
            numberPending.current = null;
            if (next != null) {
                writeNumber(next.item, next.value, next.chosen);
            }
        }, wait);
    };

    const onReset = (item: PanelItem) => {
        fireAndForget(async () => {
            await resetItem(item as any, scopes[item.id]);
            bump();
        });
    };

    const runIntent = (intent: PanelKeyIntent) => {
        const row = rows[selected];
        switch (intent.type) {
            case "move":
                setSelected(moveRowSelection(rows, selected, intent.command));
                return;
            case "activate":
                activate(row);
                return;
            case "activate-nth": {
                const index = nthSelectable(rows, intent.n);
                if (index >= 0) {
                    setSelected(index);
                    activate(rows[index]);
                }
                return;
            }
            case "open":
                if (row?.kind === "item") {
                    openPage(row.path, row.item);
                }
                return;
            case "back":
                back();
                return;
            case "step":
                if (row?.kind === "item" && row.item.type === "number") {
                    const item = row.item;
                    onNumber(item, stepNumber(item, numberValue(item), intent.delta));
                }
                return;
            case "clear-query":
                setQuery("");
                return;
            case "close":
                // A refusal or a confirmation goes first: Escape on "An unsent message will be cleared" is Cancel.
                if (feedback != null) {
                    setFeedback(null);
                    inputRef.current?.focus({ preventScroll: true });
                    return;
                }
                closePanel();
                return;
        }
    };

    const trapTab = (e: React.KeyboardEvent) => {
        const focusables = Array.from(
            panelRef.current?.querySelectorAll<HTMLElement>(
                "input:not([tabindex='-1']), button:not([tabindex='-1']):not(:disabled)"
            ) ?? []
        );
        if (focusables.length === 0) {
            return;
        }
        const at = focusables.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? focusables.length - 1 : at - 1) : (at + 1) % focusables.length;
        focusables[next]?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Every key stays in the panel: no app shortcut (Cmd+W, Cmd+D) fires behind it.
        e.stopPropagation();
        if (e.nativeEvent.isComposing) {
            return;
        }
        const cmd = isMacOS() ? e.metaKey : e.altKey;
        if (cmd && !e.shiftKey && !e.ctrlKey && e.key === ".") {
            e.preventDefault();
            closePanel();
            return;
        }
        if (e.key === "Tab") {
            e.preventDefault();
            trapTab(e);
            return;
        }
        const inInput = e.target === inputRef.current;
        // Cmd+Backspace resets the selected option at the scope being edited (the keyboard's Reset).
        const selectedRow = rows[selected];
        if (
            cmd &&
            e.key === "Backspace" &&
            selectedRow?.kind === "item" &&
            canReset(selectedRow.item as any, scopes[selectedRow.item.id])
        ) {
            e.preventDefault();
            onReset(selectedRow.item);
            return;
        }
        if (!inInput && (e.key === "Enter" || e.key === " ")) {
            // A focused footer or page button handles its own Enter and Space.
            return;
        }
        const intent = panelKeyIntent(
            { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey },
            { query, depth: liveStack.length, row: rows[selected] }
        );
        if (intent == null) {
            return;
        }
        e.preventDefault();
        if (!inInput && intent.type !== "close") {
            inputRef.current?.focus({ preventScroll: true });
        }
        runIntent(intent);
    };

    const runSuggestion = (s: PanelSuggestion) => {
        closePanel();
        fireAndForget(async () => s.run());
    };

    const digits = new Map<number, number>();
    if (meta) {
        numberedIndices(rows)
            .slice(0, 9)
            .forEach((rowIndex, i) => digits.set(rowIndex, i + 1));
    }

    const groups: { heading: PanelRow; rows: { row: PanelRow; index: number }[] }[] = [];
    rows.forEach((row, index) => {
        if (row.kind === "heading" || groups.length === 0) {
            groups.push({ heading: row.kind === "heading" ? row : null, rows: [] });
            if (row.kind === "heading") {
                return;
            }
        }
        groups[groups.length - 1].rows.push({ row, index });
    });

    const emptyText =
        query.trim() !== ""
            ? rows.length === 0
                ? `Nothing matches "${query.trim()}"`
                : null
            : liveStack.length === 0 && !hasOwnSections
              ? "This panel has no options of its own yet."
              : null;
    const pageScope = page != null ? scopes[page.id] : null;
    const panelName = ctx?.panelName ?? "panel";

    return (
        <div
            ref={(el) => {
                panelRef.current = el;
                refs.setFloating(el);
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`Commands for this ${panelName.toLowerCase()} panel`}
            data-role="command-panel"
            data-blockid-for={blockId}
            className="molten-cmdpanel flex flex-col overflow-hidden rounded-10 border border-line-strong bg-surface-2 shadow-command"
            style={{
                ...floatingStyles,
                width: PanelWidthPx,
                maxWidth: "calc(100vw - 16px)",
                visibility: isPositioned ? "visible" : "hidden",
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPointerDown={() => {
                armed.current = true;
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
            }}
        >
            <div className="flex h-row-lg shrink-0 items-center gap-2 border-b border-line px-3">
                <i className="fa fa-solid fa-magnifying-glass text-11 text-muted" aria-hidden />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={page != null ? `Search ${page.label.toLowerCase()}…` : "Search commands…"}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setFeedback(null);
                    }}
                    className="min-w-0 flex-1 bg-transparent text-12 leading-5 text-primary outline-none placeholder:text-muted"
                    role="combobox"
                    aria-expanded="true"
                    aria-autocomplete="list"
                    aria-controls={ListId}
                    aria-activedescendant={selected >= 0 ? rowDomId(rows[selected]) : undefined}
                    aria-label={`Search the commands of this ${panelName.toLowerCase()} panel`}
                />
                <span className="shrink-0 font-mono text-11 text-muted" aria-hidden>
                    {formatShortcutById("command-panel")}
                </span>
            </div>
            {feedback == null && liveStack.length === 0 && query === "" && (
                <Suggestions items={collected.suggestions} onRun={runSuggestion} />
            )}
            {page != null && (
                <PageHeader
                    page={page}
                    ctx={ctx}
                    scope={pageScope}
                    onBack={back}
                    onScope={(scope) => setScopes((s) => ({ ...s, [page.id]: scope }))}
                    onReset={() => onReset(page)}
                />
            )}
            {feedback != null && <Feedback feedback={feedback} running={running} onAction={runFeedbackAction} />}
            <div
                ref={listRef}
                key={liveStack.join("/")}
                className={cn(
                    "min-h-0 flex-1 overflow-y-auto py-1",
                    liveStack.length > 0 || direction === "back" ? `molten-cmdpanel-slide-${direction}` : null
                )}
            >
                {emptyText && (
                    <div className="px-3 py-2.5 text-12 text-muted" role="status">
                        {emptyText}
                    </div>
                )}
                <div
                    id={ListId}
                    role="listbox"
                    aria-label={page != null ? page.label : `Commands for this ${panelName.toLowerCase()} panel`}
                >
                    {groups.map((group, gi) => (
                        <div
                            key={group.heading?.key ?? `g${gi}`}
                            role="group"
                            aria-labelledby={group.heading ? `${group.heading.key}-label` : undefined}
                        >
                            {group.heading?.kind === "heading" && (
                                <div className="flex items-center px-3 pt-2 pb-1" role="presentation">
                                    <span
                                        id={`${group.heading.key}-label`}
                                        className="truncate text-11 font-medium tracking-wide text-muted uppercase"
                                    >
                                        {group.heading.title}
                                    </span>
                                    {group.heading.state && (
                                        <span
                                            className={cn(
                                                "ml-auto text-11",
                                                group.heading.stateTone === "warning" ? "text-warning" : "text-muted"
                                            )}
                                        >
                                            {group.heading.state}
                                        </span>
                                    )}
                                </div>
                            )}
                            {group.rows.map(({ row, index }) => (
                                <PanelRowView
                                    key={row.key}
                                    row={row}
                                    index={index}
                                    selected={index === selected}
                                    ctx={ctx}
                                    scopes={scopes}
                                    digit={digits.get(index) ?? 0}
                                    onHover={setSelected}
                                    onActivate={(r) => {
                                        if (!armed.current) {
                                            return;
                                        }
                                        activate(r);
                                    }}
                                    onReset={onReset}
                                    onNumber={onNumber}
                                    onScope={(item, scope) => setScopes((s) => ({ ...s, [item.id]: scope }))}
                                    pending={pending}
                                    running={running}
                                    onStep={(item, delta) => onNumber(item, stepNumber(item, numberValue(item), delta))}
                                />
                            ))}
                        </div>
                    ))}
                </div>
                {hasDeveloper && !alt && liveStack.length === 0 && query === "" && (
                    <div className="px-3 pt-1.5 pb-1 text-11 text-muted">
                        Hold {isMacOS() ? "⌥" : "Alt"} for Developer
                    </div>
                )}
            </div>
            <div
                className="flex shrink-0 items-center gap-0.5 border-t border-line px-1 py-1"
                role="group"
                aria-label="Panel actions"
            >
                {footer.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={cn(
                            "molten-cmdpanel-footer-btn flex h-7 cursor-pointer items-center gap-1.5 rounded-6 px-1.5 text-12 whitespace-nowrap text-secondary",
                            item.destructive && "is-destructive ml-auto"
                        )}
                        title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
                        aria-keyshortcuts={item.shortcut || undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => runAction(item)}
                    >
                        <i className={cn(panelIconClass(item.icon), "text-icon-14")} aria-hidden />
                        {item.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function CommandPanelHost() {
    useState(() => {
        registerBuiltinCommandProviders();
        trackContextMenuPoint();
        return true;
    });
    const model = CommandPanelModel.getInstance();
    const open = useAtomValue(model.openAtom);
    const layerRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (layer == null || typeof layer.showPopover !== "function") {
            return;
        }
        if (open && !layer.matches(":popover-open")) {
            layer.showPopover();
        }
        if (!open && layer.matches(":popover-open")) {
            layer.hidePopover();
        }
    }, [open]);
    const outside = (e: React.SyntheticEvent) => {
        if ((e.target as HTMLElement).closest?.('[data-role="command-panel"]')) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        model.close();
    };
    return (
        <div
            ref={layerRef}
            popover="manual"
            className="molten-cmdpanel-layer"
            onPointerDown={outside}
            onContextMenu={outside}
        >
            {open && <CommandPanel key={open.token} open={open} />}
        </div>
    );
}
