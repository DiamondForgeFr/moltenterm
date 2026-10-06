// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first-link engine choice (FR-BRW-006, DS-BRW-007): the page of an interface link to a site without a choice is
// already loading in MoltenTerm's engine; this calm bar above it offers the installed browser, and remembers the answer
// for the site unless the user unchecks it. Closing it, Escape or moving on in the page keeps MoltenTerm and stores
// nothing, so the next link to the site asks again.

import { Button } from "@/app/element/button";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { browserIconClass, BrowserList, InstalledBrowser } from "./browser-engine";
import { choiceBarVisible, choiceBrowsers, choiceOnNavigate, EngineChoice, makeEngineChoice } from "./link-choice";

// The pending choices of one panel, per tab, in memory only: a restart drops them, which reads as a dismissal.
export class BrowserChoiceModel {
    choicesAtom = atom({}) as PrimitiveAtom<Record<string, EngineChoice>>;
    // The bar's primary button, focused when the panel takes the focus for the link.
    primaryRef: React.RefObject<HTMLButtonElement> = { current: null };

    get(tabId: string): EngineChoice {
        return globalStore.get(this.choicesAtom)[tabId];
    }

    set(tabId: string, next: EngineChoice): void {
        const all = globalStore.get(this.choicesAtom);
        if (all[tabId] === next) {
            return;
        }
        if (next == null) {
            if (!(tabId in all)) {
                return;
            }
            const rest = { ...all };
            delete rest[tabId];
            globalStore.set(this.choicesAtom, rest);
            return;
        }
        globalStore.set(this.choicesAtom, { ...all, [tabId]: next });
    }

    ask(tabId: string, url: string, site: string): void {
        this.set(tabId, makeEngineChoice(url, site));
    }

    noteNavigation(tabId: string): void {
        this.set(tabId, choiceOnNavigate(this.get(tabId)));
    }

    setRemember(tabId: string, remember: boolean): void {
        const choice = this.get(tabId);
        if (choice == null || choice.remember === remember) {
            return;
        }
        this.set(tabId, { ...choice, remember });
    }

    forget(tabId: string): void {
        this.set(tabId, null);
    }

    // Whether the tab shows the bar now (settings and detected browsers included).
    visible(tabId: string, list: BrowserList): boolean {
        return choiceBarVisible(
            this.get(tabId),
            globalStore.get(getSettingsKeyAtom("browser:default")),
            globalStore.get(getSettingsKeyAtom("browser:sites")),
            list
        );
    }
}

export type EngineChoiceBarProps = {
    choices: BrowserChoiceModel;
    tabId: string;
    list: BrowserList;
    onStay: (choice: EngineChoice) => void;
    onHandOff: (choice: EngineChoice, browser: InstalledBrowser) => void;
    onDismiss: () => void;
};

export function EngineChoiceBar({ choices, tabId, list, onStay, onHandOff, onDismiss }: EngineChoiceBarProps) {
    const all = useAtomValue(choices.choicesAtom);
    const defaultEngine = useAtomValue(getSettingsKeyAtom("browser:default"));
    const sites = useAtomValue(getSettingsKeyAtom("browser:sites"));
    const choice = all[tabId];
    const visible = choiceBarVisible(choice, defaultEngine, sites, list);
    useEffect(() => {
        if (visible) {
            choices.primaryRef.current?.focus();
        }
    }, [choices, visible, tabId]);
    if (!visible) {
        return null;
    }
    const browsers = choiceBrowsers(list);
    const first = browsers[0];
    const others = browsers.slice(1);
    const showOthers = (e: React.MouseEvent) => {
        ContextMenuModel.getInstance().showContextMenu(
            others.map((b) => ({ label: `Open in ${b.name}`, click: () => onHandOff(choice, b) })),
            e
        );
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Escape") {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
    };
    return (
        <div
            role="group"
            aria-label={`Where ${choice.site} opens`}
            onKeyDown={onKeyDown}
            className="molten-browser-choice flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-2 py-1.5 text-xs"
        >
            <i className="fa fa-solid fa-globe shrink-0 text-[11px] text-secondary" />
            <span className="min-w-[150px] flex-1 truncate text-secondary">
                <span className="text-primary">{choice.site}</span> opened in MoltenTerm.
            </span>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button ref={choices.primaryRef} className="!h-6 !px-2.5 !text-xs" onClick={() => onStay(choice)}>
                    Open with MoltenTerm
                </Button>
                <div className="flex h-6 items-center rounded border border-border text-secondary">
                    <button
                        type="button"
                        onClick={() => onHandOff(choice, first)}
                        title={`Open this page in ${first.name}, with your sessions and extensions`}
                        className={cn(
                            "flex h-full cursor-pointer items-center gap-1.5 px-2 hover:bg-hover hover:text-primary",
                            others.length > 0 ? "rounded-l" : "rounded"
                        )}
                    >
                        <i className={cn(browserIconClass(first.id), "text-[11px]")} />
                        <span className="whitespace-nowrap">Open in {first.name}</span>
                    </button>
                    {others.length > 0 ? (
                        <button
                            type="button"
                            aria-label="Other browsers"
                            title="Other browsers"
                            onClick={showOthers}
                            className="flex h-full cursor-pointer items-center rounded-r border-l border-border px-1.5 hover:bg-hover hover:text-primary"
                        >
                            <i className="fa fa-solid fa-chevron-down text-[9px]" />
                        </button>
                    ) : null}
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-secondary select-none hover:text-primary">
                    <input
                        type="checkbox"
                        checked={choice.remember}
                        onChange={(e) => choices.setRemember(tabId, e.target.checked)}
                        className="cursor-pointer accent-accent"
                    />
                    Remember for {choice.site}
                </label>
                <button
                    type="button"
                    aria-label="Dismiss"
                    title="Keep MoltenTerm for this page, and ask again next time"
                    onClick={onDismiss}
                    className="cursor-pointer rounded px-1 text-secondary hover:bg-hover hover:text-primary"
                >
                    <i className="fa fa-solid fa-xmark text-[10px]" />
                </button>
            </div>
        </div>
    );
}
