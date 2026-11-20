// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The dialog of agent-choice.tsx (#758, #930, #2431), loaded on demand by its host: the picker only shows when an agent is
// to start, so its code stays out of the first JavaScript every view loads (NFR-PERF-003, bundle.initialJsMB).

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
import { orderProviders, preferredProviderId } from "../agent-info/providers-in-use";
import { ProviderUseAtom } from "../agent-info/providers-in-use-use";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { AgentMode } from "../review/review-client";
import { SegmentedControl } from "../segmented-control";
import { nextToggleIndex, RadioDot } from "../suite/suite";
import {
    agentTabName,
    answerAgentChoice,
    ChoiceKeys,
    DefaultMode,
    PendingChoice,
    pickedAgent,
    PlainButton,
} from "./agent-choice";

export function AgentChoiceDialog({ pending }: { pending: PendingChoice }) {
    const t = useT();
    const defaultRef = useRef<HTMLButtonElement>(null);
    const [picked, setPicked] = useState<string>(null);
    const [selected, setSelected] = useState<AgentMode>(DefaultMode);
    const agent = pickedAgent(pending, picked);
    const installed = (pending.agents ?? []).filter((a) => a.installed);
    const usage = useAtomValue(ProviderUseAtom);
    const order = orderProviders(
        pending.agents ?? [],
        (id) => usage.last[id] ?? 0,
        Date.now(),
        usage.windowMs,
        preferredProviderId(pending.prAgent, pending.agents)
    );
    const validate = () => answerAgentChoice(pending, picked, selected);
    useEffect(() => {
        defaultRef.current?.focus();
    }, [pending]);
    const keys = ChoiceKeys[pending.kind];
    const vars = {
        number: pending.number,
        branch: pending.branch,
        base: pending.base,
        round: pending.round ?? 0,
        checks: pending.checks ?? "",
        agent:
            (pending.agents ?? []).find((a) => a.id === agent)?.name ||
            (agent === pending.agentid ? pending.agent : "") ||
            t("agentChoice.yourAgent"),
        tab: agentTabName(pending.kind, pending.number),
        missing: pending.missing ?? "",
    };
    const options: { mode: AgentMode; icon: string; title: string; text: string }[] = [
        {
            mode: "background",
            icon: "fa-eye-slash",
            title: t("agentChoice.background.button"),
            text: t("agentChoice.background.text", vars),
        },
        { mode: "together", icon: "fa-terminal", title: t(keys.together), text: t("agentChoice.together.text", vars) },
    ];
    // Enter anywhere in the body validates, on a radio too: preventDefault keeps the radio's native click from
    // running as well.
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Enter") {
            return;
        }
        e.preventDefault();
        validate();
    };
    const onOptionsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-option]"));
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
        setSelected(buttons[next].dataset.option as AgentMode);
    };
    return (
        <DialogFrame
            role="agent-choice"
            onEscape={() => pending.answer(null)}
            title={t(keys.title, vars)}
            subtitle={t("agentChoice.subtitle", vars)}
            widthClass="w-[520px]"
            trapFocus
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer(null)}
                        data-testid="agent-choice-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12 disabled:cursor-default"
                        onClick={validate}
                        disabled={!agent}
                        data-testid="agent-choice-validate"
                    >
                        {t("agentChoice.validate")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12 leading-5" onKeyDown={onKeyDown} data-testid="agent-choice">
                {pending.missing ? (
                    <p className="text-warning" data-testid="agent-choice-missing">
                        {t(installed.length > 0 ? "agentChoice.missing" : "agentChoice.missingNone", vars)}
                    </p>
                ) : null}
                {order.shown.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2" data-testid="agent-choice-agents">
                        <span className="text-muted">{t("agentChoice.agent")}</span>
                        <SegmentedControl
                            label={t("agentChoice.agent")}
                            segments={order.shown.map((a) => ({ value: a.id, label: a.name }))}
                            selected={agent}
                            onSelect={setPicked}
                        />
                    </div>
                ) : null}
                {order.other.length > 0 ? (
                    <details
                        className="text-12"
                        open={order.shown.length === 0 || order.other.some((a) => a.id === agent)}
                        data-testid="agent-choice-others"
                    >
                        <summary className="cursor-pointer text-muted">{t("agentChoice.otherAgents")}</summary>
                        <div className="mt-2">
                            <SegmentedControl
                                label={t("agentChoice.otherAgents")}
                                segments={order.other.map((a) => ({ value: a.id, label: a.name }))}
                                selected={agent}
                                onSelect={setPicked}
                            />
                        </div>
                    </details>
                ) : null}
                {picked != null && picked !== pending.agentid && !pending.missing ? (
                    <p className="text-11 text-muted">{t("agentChoice.thisRunOnly")}</p>
                ) : null}
                <p className="text-secondary">{t(keys.what, vars)}</p>
                <div
                    role="radiogroup"
                    aria-label={t("agentChoice.how")}
                    className="df-option-list overflow-hidden rounded-4 border border-border"
                    onKeyDown={onOptionsKeyDown}
                    data-testid="agent-choice-options"
                >
                    {options.map((o) => (
                        <ChoiceOption
                            key={o.mode}
                            ref={o.mode === DefaultMode ? defaultRef : undefined}
                            mode={o.mode}
                            icon={o.icon}
                            title={o.title}
                            text={o.text}
                            isDefault={o.mode === DefaultMode}
                            selected={o.mode === selected}
                            disabled={!agent}
                            onSelect={() => setSelected(o.mode)}
                        />
                    ))}
                </div>
                <p className="text-muted">{t(keys.checkout, vars)}</p>
            </div>
        </DialogFrame>
    );
}

// One way to run the agent, drawn like the suite's OptionRow; pressing it only selects it.
function ChoiceOption({
    ref,
    mode,
    icon,
    title,
    text,
    isDefault,
    selected,
    disabled,
    onSelect,
}: {
    ref?: React.Ref<HTMLButtonElement>;
    mode: AgentMode;
    icon: string;
    title: string;
    text: string;
    isDefault: boolean;
    selected: boolean;
    disabled: boolean;
    onSelect: () => void;
}) {
    const t = useT();
    const titleId = useId();
    const textId = useId();
    return (
        <button
            ref={ref}
            type="button"
            className={cn(
                "df-option-row w-full cursor-pointer items-start text-left text-12 leading-5",
                "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--mt-focus-ring)",
                "disabled:cursor-default"
            )}
            role="radio"
            aria-checked={selected}
            data-selected={selected ? "" : undefined}
            data-disabled={disabled ? "" : undefined}
            data-option={mode}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            aria-labelledby={titleId}
            aria-describedby={textId}
            onClick={onSelect}
            data-testid={`agent-choice-${mode}`}
        >
            <span className="mt-0.5">
                <RadioDot />
            </span>
            <i className={cn("fa fa-solid mt-1 w-4 shrink-0 text-center text-11 text-muted", icon)} aria-hidden />
            <span className="min-w-0 flex-1">
                <span id={titleId} className="block font-medium text-primary">
                    {title}
                    {isDefault ? " " : null}
                    {isDefault ? (
                        <span className="ml-2 text-10 font-semibold tracking-[0.08em] text-muted uppercase">
                            {t("agentChoice.default")}
                        </span>
                    ) : null}
                </span>
                <span id={textId} className="block text-secondary">
                    {text}
                </span>
            </span>
        </button>
    );
}
