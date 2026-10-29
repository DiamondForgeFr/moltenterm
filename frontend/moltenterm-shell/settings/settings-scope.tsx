// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Who a settings block applies to (FR-SHELL-101): a tag on the top border of every block of Preferences and of the
// workspace sheet, across from the block's name, and the notice on an app setting that workspaces replace with their
// own value. The workspace scope takes the workspace's colour (--mt-place marks the place, #1319); the app scope stays
// neutral.

import { cn } from "@/util/util";
import { useT, useTCount } from "../i18n/i18n";

export type SettingsScopeKind = "app" | "workspace" | "project";

const ScopeIcons: Record<SettingsScopeKind, string> = {
    app: "globe",
    workspace: "layer-group",
    project: "folder",
};

export function ScopeLine({ scope, className }: { scope: SettingsScopeKind; className?: string }) {
    const t = useT();
    return (
        <span
            data-scope={scope}
            className={cn(
                "flex items-center gap-1.5 text-11 leading-4",
                scope === "app" ? "text-muted" : "text-(--mt-place)",
                className
            )}
        >
            <i className={`fa fa-solid fa-${ScopeIcons[scope]} text-10`} aria-hidden />
            <span>{t(`settings.scope.${scope}`)}</span>
        </span>
    );
}

// The scope on a suite block's top border, at the right: a block's last child, so it costs the block no height and the
// suite's first-child spacing rules still see the block's own content. Positioned against the block (.df-block is
// relative, its body is not).
export function BlockScopeTag({ scope }: { scope: SettingsScopeKind }) {
    return (
        <ScopeLine
            scope={scope}
            className="absolute top-0 right-5 h-5 max-w-[50%] -translate-y-1/2 rounded-full border border-(--df-line) bg-(--df-surface) px-2 whitespace-nowrap"
        />
    );
}

// "Overridden in 2 workspaces" on an app setting, the workspaces' names on hover.
export function OverriddenNotice({ names }: { names: string[] }) {
    const t = useT();
    const tCount = useTCount();
    if (names == null || names.length === 0) {
        return null;
    }
    const text = tCount("settings.overridden", names.length);
    return (
        <div
            data-overridden={names.length}
            className="flex min-w-0 items-center gap-1.5 text-11 leading-4 text-(--mt-place)"
            title={t("settings.overridden.title", { names: names.join(", ") })}
        >
            <i className="fa fa-solid fa-layer-group text-10" aria-hidden />
            <span className="truncate">{text}</span>
        </div>
    );
}
