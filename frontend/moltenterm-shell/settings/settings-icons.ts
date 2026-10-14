// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The suite icon (suite/suite-icons.ts, #658) of each settings section and group, so Settings draws the same icon as
// Notulia for a shared concept. Groups are named by their English slug (groupSlug), which does not change with the
// interface language; a group missing here gets the "tools" icon.

import {
    AppWindow,
    ArrowDownAZ,
    Clock,
    Cloud,
    ExternalLink,
    Eye,
    EyeOff,
    Laptop,
    PanelLeft,
    PanelTop,
    Rocket,
    Square,
    TextCursor,
    Underline,
    Wand2,
} from "lucide-react";
import type { SuiteIcon } from "../suite/suite";
import type { SuiteIconName } from "../suite/suite-icons";
import type { SettingsSectionId } from "./settings-catalog";

export const SettingsSectionIcons: Record<SettingsSectionId, SuiteIconName> = {
    general: "settings",
    appearance: "appearance",
    terminal: "terminal",
    agents: "agent",
    browser: "web",
    mission: "mission",
    keyboard: "keyboard",
    mods: "mods",
    secrets: "secrets",
    advanced: "tools",
};

const GroupIcons: Record<string, SuiteIconName> = {
    thisWorkspace: "workspace",
    quittingAndClosing: "quitting",
    startup: "startup",
    panels: "panels",
    filesAndEditor: "notes",
    power: "power",
    updates: "updates",
    language: "language",
    window: "window",
    "360View": "overview",
    text: "text",
    magnifiedPanel: "magnify",
    look: "appearance",
    behaviour: "behaviour",
    shell: "shell",
    connections: "connections",
    terminal: "terminal",
    integration: "integration",
    companion: "companion",
    codeReview: "review",
    agents: "agent",
    browserPanel: "web",
    openingPages: "openExternal",
    ciCd: "ci",
    lineMap: "lineMap",
    keys: "keyboard",
    app: "configuration",
    appBuilder: "builder",
    debugging: "debugging",
};

export function settingsGroupIcon(slug: string): SuiteIconName {
    return GroupIcons[slug] ?? "tools";
}

// The icon of each choice where one says more than the label; a choice missing here has none.
const OptionIcons: Record<string, Record<string, SuiteIcon>> = {
    "app:tabbar": { top: PanelTop, left: PanelLeft },
    "browser:default": { app: AppWindow, installed: ExternalLink },
    "preview:defaultsort": { name: ArrowDownAZ, modtime: Clock },
    "cicd:runs": { local: Laptop, remote: Cloud, cd: Rocket },
    "term:cursor": { block: Square, bar: TextCursor, underline: Underline },
    "moltenterm:view360": { auto: Wand2, always: Eye, never: EyeOff },
};

export function settingsOptionIcon(key: string, value: string): SuiteIcon {
    return OptionIcons[key]?.[value];
}
