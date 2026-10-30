// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The keep-awake cup of the window row (FR-SHELL-103, #1408): a shortcut dedicated to the function it stands for. A left
// click turns coffee mode on or off for the workspace the window shows; a right click (Shift+F10 or the context-menu key
// on the keyboard) opens a small popover with what keeps the computer awake now and the sleep policy, drawn by the same
// control as Preferences › Energy. Preferences is one discreet link away, never the click's target.

import { atoms, useSettingsKeyAtom } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { writeSettings } from "./command-panel/bindings";
import { useT } from "./i18n/i18n";
import "./keepawake-cup.css";
import {
    coffeeCondition,
    coffeeSupported,
    keepAwakeActive,
    keepAwakeCount,
    keepAwakeIndicatorLabel,
    policyHoldingLine,
    sleepPolicyLabel,
    SleepPolicySetting,
} from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { useNow, usePlatform } from "./keepawake-ui";
import { MenuPopover } from "./mission/menu-popover";
import { localizeCatalog, settingChoices, settingsCatalog } from "./settings/settings-catalog";
import { ChoiceRows } from "./settings/settings-choice-rows";
import { openSettingsKey } from "./settings/settings-open";
import { snapToCycle } from "./suite/suite";
import { workspaceShownName } from "./workspace-default-name";

function SteamLine({ index }: { index: number }) {
    return (
        <span className={`mt-cup-steam mt-cup-steam-${index}`}>
            <svg viewBox="0 0 3 5.5" fill="none" stroke="currentColor" strokeWidth={0.9} strokeLinecap="round">
                <path d="M1.5 0.4C0.5 1.5 2.5 2.7 1.5 3.9S0.9 4.8 1.5 5.1" />
            </svg>
        </span>
    );
}

// The window row's cup, drawn in SVG so its steam can wave when coffee mode is on (DS-SHELL-151). The mug is a 16 unit
// square; the three steam lines are boxes of their own, moved by transform only (keepawake-cup.css).
function CupIcon({ on, className }: { on: boolean; className: string }) {
    return (
        <span
            className={cn("mt-cup", className)}
            data-on={on ? "" : undefined}
            data-testid="keepawake-cup-icon"
            aria-hidden
            onAnimationStart={(e) => {
                for (const anim of e.currentTarget.getAnimations?.({ subtree: true }) ?? []) {
                    anim.ready.then(() => snapToCycle(anim)).catch(() => {});
                }
            }}
        >
            <svg className="mt-cup-body" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 7.5h9.2v4.3A3.2 3.2 0 0 1 8 15H5.2A3.2 3.2 0 0 1 2 11.8z" />
                <path
                    d="M11.2 9h1.1a1.8 1.8 0 0 1 0 3.6h-1.1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                />
            </svg>
            <SteamLine index={1} />
            <SteamLine index={2} />
            <SteamLine index={3} />
        </span>
    );
}

function PolicyChoices() {
    const t = useT();
    const platform = usePlatform();
    const value = useSettingsKeyAtom(SleepPolicySetting);
    const entry = useMemo(
        () => localizeCatalog(settingsCatalog(platform), t).find((e) => e.key === SleepPolicySetting),
        [platform, t]
    );
    const choices = useMemo(() => (entry ? settingChoices(entry, [], "") : null), [entry]);
    if (entry == null || choices == null) {
        return null;
    }
    return (
        <ChoiceRows
            entry={entry}
            name="keepawake-popover-policy"
            choices={choices}
            value={value}
            onSet={(v) => fireAndForget(() => writeSettings({ [SleepPolicySetting]: v ?? null }))}
        />
    );
}

export function KeepAwakePopover({ anchor, onClose }: { anchor: Element; onClose: () => void }) {
    const t = useT();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    const platform = usePlatform();
    const active = keepAwakeActive(state);
    const now = useNow(active);
    const holding = policyHoldingLine(state, platform, now);
    return (
        <MenuPopover
            anchor={anchor}
            onClose={onClose}
            placement="bottom-end"
            role="dialog"
            ariaLabel={t("keepawake.popover.title")}
            className="flex w-[300px] flex-col gap-3 p-0"
        >
            <div className="flex flex-col gap-1 px-3 pt-3" data-testid="keepawake-now">
                <div className="text-12 font-medium text-primary">{t("keepawake.popover.title")}</div>
                {active ? (
                    <div className="text-12 text-[var(--color-awake)]">{keepAwakeIndicatorLabel(state)}</div>
                ) : (
                    <div className="text-12 text-muted">{t("keepawake.cupIdle")}</div>
                )}
                {holding ? <div className="text-12 text-muted">{holding}</div> : null}
                {state.coffees.map((coffee) => {
                    const name = workspaceShownName(coffee.workspacename, t) || t("keepawake.workspace");
                    return (
                        <div key={coffee.workspaceid} className="flex items-center gap-2 text-12">
                            <i className="fa fa-solid fa-mug-hot text-11 text-[var(--color-awake)]" aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-primary">
                                {name}
                                <span className="text-muted"> · {coffeeCondition(coffee, now)}</span>
                            </span>
                            <button
                                type="button"
                                className="shrink-0 cursor-pointer rounded-6 border border-border px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary"
                                aria-label={t("keepawake.railStop", { name })}
                                onClick={() => fireAndForget(() => model.setCoffee(coffee.workspaceid, false))}
                            >
                                {t("keepawake.stop")}
                            </button>
                        </div>
                    );
                })}
            </div>
            <PolicyChoices />
            <div className="border-t border-border px-3 py-2">
                <button
                    type="button"
                    data-testid="keepawake-more-settings"
                    className="cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => {
                        onClose();
                        fireAndForget(() => openSettingsKey("general", SleepPolicySetting));
                    }}
                >
                    {t("keepawake.popover.moreSettings")}
                </button>
            </div>
        </MenuPopover>
    );
}

// The cup stays in the window row while nothing keeps the computer awake (calm), so coffee mode can be turned back on.
// aria-pressed is the current workspace's coffee, the thing a click changes, and the icon itself says it: coloured,
// with waving steam, while on (#1470); a background would read as hover. The text brightens a little while something
// else holds. The workspace sidebar (#1183) draws it as a 28 px icon button, with a count when more than one thing holds.
export function KeepAwakeStatusItem({ variant = "status" }: { variant?: "status" | "sidebar" }) {
    const t = useT();
    const platform = usePlatform();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    const policy = useSettingsKeyAtom(SleepPolicySetting);
    const workspace = useAtomValue(atoms.workspace);
    const coffee = useAtomValue(model.coffeeAtom(workspace?.oid));
    const [anchor, setAnchor] = useState<Element>(null);
    if (!coffeeSupported(platform)) {
        return null;
    }
    const on = coffee != null;
    const active = keepAwakeActive(state);
    const count = keepAwakeCount(state);
    const sidebar = variant === "sidebar";
    const name = workspaceShownName(workspace?.name, t) || t("keepawake.thisWorkspace");
    const title = [
        t("keepawake.cupTitle", {
            state: t(on ? "keepawake.cupCoffeeOn" : "keepawake.cupCoffeeOff"),
            reason: active ? keepAwakeIndicatorLabel(state) : t("keepawake.cupIdle"),
        }),
        t("keepawake.indicatorPolicy", { policy: sleepPolicyLabel(policy ?? "") }),
        t("keepawake.cupHint"),
    ].join("\n");
    const toggle = () => {
        if (workspace?.oid == null) {
            return;
        }
        fireAndForget(async () => {
            try {
                await model.setCoffee(workspace.oid, !on);
            } catch (err) {
                console.log("keep-awake coffee:", err);
            }
        });
    };
    return (
        <>
            <button
                type="button"
                aria-label={t("keepawake.coffeeFor", { name })}
                aria-pressed={on}
                aria-haspopup="dialog"
                title={title}
                data-testid="keepawake-item"
                data-lit={active ? "" : undefined}
                onClick={toggle}
                onContextMenu={(e) => {
                    e.preventDefault();
                    setAnchor(e.currentTarget);
                }}
                style={sidebar ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
                className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-6 hover:bg-hover hover:text-primary",
                    active ? "text-[var(--color-awake)]" : "text-muted",
                    sidebar ? "relative h-7 w-7 shrink-0 justify-center transition-colors duration-120 ease-mt" : "px-1"
                )}
            >
                <CupIcon on={on} className={sidebar ? "text-icon-14" : "text-11"} />
                {count > 1 && !sidebar ? <span>{count}</span> : null}
                {count > 1 && sidebar ? (
                    <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary/85 px-[3px] text-11 leading-none font-semibold text-[var(--mt-text-inverse)] tabular-nums">
                        {count}
                    </span>
                ) : null}
            </button>
            {anchor ? (
                <KeepAwakePopover
                    anchor={anchor}
                    onClose={() => {
                        (anchor as HTMLElement).focus();
                        setAnchor(null);
                    }}
                />
            ) : null}
        </>
    );
}
