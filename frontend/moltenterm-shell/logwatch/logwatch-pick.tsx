// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Who looks at a log watch card (FR-BOSS-012 AC9) when no lead of MoltenTerm's repository stands out: that repository's
// running agents as wavesrv lists them (no other project's), the first one selected. Opened by the developer's click on Ask an agent to
// look, loaded only then (logwatch-gestures.ts), mounted in a root of its own and gone once answered. The arrows and a
// click only select; Send (or Enter) answers with the selected agent, Cancel and Escape with none.

import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { nextToggleIndex, RadioDot } from "../suite/suite";
import { candidateDetails, LogWatchCandidate } from "./logwatch-model";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export function LogWatchPickDialog({
    agents,
    onAnswer,
}: {
    agents: LogWatchCandidate[];
    onAnswer: (blockid: string) => void;
}) {
    const t = useT();
    const [selected, setSelected] = useState(agents[0]?.blockid ?? "");
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listRef.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']")?.focus();
    }, []);
    const send = () => {
        if (selected) {
            onAnswer(selected);
        }
    };
    const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            send();
            return;
        }
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-agent]"));
        const next = nextToggleIndex(
            e.key,
            buttons.indexOf(document.activeElement as HTMLButtonElement),
            buttons.length
        );
        if (next < 0) {
            return;
        }
        e.preventDefault();
        buttons[next].focus();
        setSelected(buttons[next].dataset.agent);
    };
    return (
        <DialogFrame
            role="logwatch-pick"
            onEscape={() => onAnswer("")}
            title={t("logwatch.pick.title")}
            subtitle={t("logwatch.pick.subtitle")}
            subtitleWraps
            widthClass="w-[480px]"
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => onAnswer("")}
                        data-testid="logwatch-pick-cancel"
                    >
                        {t("logwatch.pick.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12 disabled:cursor-default"
                        onClick={send}
                        disabled={!selected}
                        data-testid="logwatch-pick-send"
                    >
                        {t("logwatch.pick.send")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div
                ref={listRef}
                role="radiogroup"
                aria-label={t("logwatch.pick.agents")}
                className="df-option-list max-h-[320px] overflow-auto rounded-4 border border-border"
                onKeyDown={onListKeyDown}
                data-testid="logwatch-pick"
            >
                {agents.map((a) => {
                    const isSelected = a.blockid === selected;
                    const details = candidateDetails(a);
                    return (
                        <button
                            key={a.blockid}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            data-selected={isSelected ? "" : undefined}
                            data-agent={a.blockid}
                            tabIndex={isSelected ? 0 : -1}
                            onClick={() => setSelected(a.blockid)}
                            className={cn(
                                "df-option-row w-full cursor-pointer items-start text-left text-12 leading-5",
                                "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
                            )}
                            data-testid="logwatch-pick-agent"
                        >
                            <span className="mt-0.5">
                                <RadioDot />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block font-medium text-primary">{a.firstname}</span>
                                {details !== "" ? <span className="block truncate text-muted">{details}</span> : null}
                            </span>
                        </button>
                    );
                })}
            </div>
        </DialogFrame>
    );
}

// pickAgent shows the pick and resolves with the selected agent's block id, "" when the developer cancels.
export function pickAgent(agents: LogWatchCandidate[]): Promise<string> {
    if (agents.length === 0) {
        return Promise.resolve("");
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    return new Promise((resolve) => {
        const onAnswer = (blockid: string) => {
            root.unmount();
            container.remove();
            resolve(blockid);
        };
        root.render(<LogWatchPickDialog agents={agents} onAnswer={onAnswer} />);
    });
}
