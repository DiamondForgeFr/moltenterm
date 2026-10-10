// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command panel of a panel (FR-SHELL-047, DS-SHELL-085, DS-SHELL-086): what providers declare. A provider
// matches a panel by its capabilities and returns sections of items; the panel orders the sections by kind, never by
// registration, so a terminal running an agent gets Agent, MoltenTerm, Terminal and (with Option) Developer.

import type { AgentStateInfo } from "../agent-state-model";

export type PanelSectionKind = "agent" | "molten" | "widget" | "developer";

// The fixed order of the sections (FR-SHELL-047-AC2). The footer's block actions are a pseudo-section that only
// search shows (Split right, Magnify…), kept after the others.
export const PanelSectionOrder: PanelSectionKind[] = ["agent", "molten", "widget", "developer"];

// Where an option's value lives: block meta (This panel), what MoltenTerm remembers for the active project (This
// project: a Mission Control view's choice), the workspace's meta, the settings of the panel kind (All terminals) or
// the global settings (Everywhere).
export type PanelScopeId = "panel" | "project" | "workspace" | "kind" | "global";

export const PanelScopeOrder: PanelScopeId[] = ["panel", "project", "workspace", "kind", "global"];

// One place an option can be set. get() returns undefined when nothing is set at this scope (or, for settings, when
// the value equals the built-in default), so Reset shows only when there is something to clear.
export type ScopeBinding<T> = {
    scope: PanelScopeId;
    get: () => T | undefined;
    set: (value: T) => void | Promise<void>;
    clear: () => void | Promise<void>;
};

type PanelItemBase = {
    id: string;
    label: string;
    icon?: string;
    // Secondary text after the label.
    detail?: string;
    // Extra words the search matches.
    keywords?: string[];
    // Formatted keys (⌘D) or an agent's slash command, shown in mono on the right.
    shortcut?: string;
    // A disabled item stays visible with its reason in the tooltip and cannot run.
    disabled?: boolean;
    disabledReason?: string;
    destructive?: boolean;
};

// What an action that waits for its result tells the panel (FR-SHELL-048): nothing or "close" closes it and gives
// the focus back to the panel; "dismiss" only takes the feedback away; a feedback keeps it open and shows why, with
// what to do next.
export type PanelActionResult = void | "close" | "dismiss" | PanelFeedback;

export type PanelFeedbackAction = {
    id: string;
    label: string;
    primary?: boolean;
    destructive?: boolean;
    run: () => PanelActionResult | Promise<PanelActionResult>;
};

// A message shown in the panel in place of the suggestions: a refusal ("Claude Code is working") or a confirmation
// ("An unsent message will be cleared", tone warning, role alertdialog).
export type PanelFeedback = {
    id: string;
    message: string;
    tone?: "warning" | "danger" | "muted";
    // alertdialog: a question the user answers with one of the actions; alert: an explanation.
    role?: "alert" | "alertdialog";
    actions?: PanelFeedbackAction[];
};

export type PanelAction = PanelItemBase & {
    type: "action";
    run: () => void | Promise<void> | PanelActionResult | Promise<PanelActionResult>;
    // The panel stays open after the action (a copy, a reload of the list).
    keepOpen?: boolean;
    // The panel stays open while the action runs and acts on its result (an agent command typed by wavesrv).
    awaitResult?: boolean;
};

// A value set in one or more scopes. Without scopes the option is a plain value with a setter (Wave's items).
type PanelValueItem<T> = PanelItemBase & {
    scopes?: ScopeBinding<T>[];
    defaultValue?: T;
    value?: T;
    set?: (value: T) => void | Promise<void>;
};

export type PanelToggle = PanelValueItem<boolean> & { type: "toggle" };

export type PanelChoiceOption = {
    id: string;
    label: string;
    value?: unknown;
    icon?: string;
    detail?: string;
    // Colours drawn as a small swatch (a terminal theme's background and foreground).
    swatch?: string[];
    // Wave's items carry their own state and click.
    checked?: boolean;
    run?: () => void | Promise<void> | PanelActionResult | Promise<PanelActionResult>;
    disabled?: boolean;
};

export type PanelChoice = PanelValueItem<unknown> & {
    type: "choice";
    options: PanelChoiceOption[];
    // The options' run() answers a PanelActionResult the panel acts on, as an action's with awaitResult.
    awaitResult?: boolean;
};

export type PanelPage = PanelItemBase & {
    type: "page";
    // A state shown on the right before the chevron, as a choice shows its value (Durable session: On).
    valueLabel?: string;
    items: PanelItem[];
};

export type PanelNumber = PanelValueItem<number> & {
    type: "number";
    min: number;
    max: number;
    step: number;
    control?: "stepper" | "slider";
    format?: (value: number) => string;
};

export type PanelInfo = PanelItemBase & { type: "info" };

export type PanelItem = PanelAction | PanelToggle | PanelChoice | PanelPage | PanelNumber | PanelInfo;

export type PanelSection = {
    id: string;
    kind: PanelSectionKind;
    title: string;
    // A right-aligned state next to the heading ("waiting").
    state?: string;
    stateTone?: "warning" | "muted";
    items: PanelItem[];
};

// An urgent, contextual action shown as a chip under the search (a waiting agent's question, an offer).
export type PanelSuggestion = {
    id: string;
    label: string;
    icon?: string;
    tone?: "warning" | "accent";
    // The verb after the label ("Go"), when the label is a statement (a waiting agent's question).
    action?: string;
    run: () => void | Promise<void>;
};

export type PanelContext = {
    blockId: string;
    view: string;
    meta: MetaType;
    viewModel: ViewModel;
    // "terminal", "agent", "agent:<id>", "browser", "remote", "view:<type>" and whatever a view adds.
    capabilities: Set<string>;
    agent: AgentStateInfo;
    // The panel kind in the plural for the kind scope ("terminals" → "All terminals").
    kindLabel: string;
    // The panel's name for the dialog's label ("Terminal").
    panelName: string;
};

export type CommandProvider = {
    id: string;
    kind: PanelSectionKind;
    // Capabilities the panel must have, all of them; "agent:*" matches any agent.
    needs?: string[];
    when?: (ctx: PanelContext) => boolean;
    sections: (ctx: PanelContext) => PanelSection[];
    suggestions?: (ctx: PanelContext) => PanelSuggestion[];
    // Inside a kind, lower first; ties by id. Registration order never counts.
    order?: number;
    // A widget fallback applies only when no other widget provider matches (the Wave adapter).
    fallback?: boolean;
};

export type CollectedPanel = {
    sections: PanelSection[];
    suggestions: PanelSuggestion[];
};
