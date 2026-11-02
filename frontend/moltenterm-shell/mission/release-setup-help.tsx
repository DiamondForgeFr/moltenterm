// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Each step's "Question" in the pipeline setup (#1152, FR-MC-044). A screen wraps its content in <HelpScope dir screen
// context> and puts <QuestionButton step> beside each step. The scope also tells the panel's "Ask for help"
// (pipeline-agent-ui.tsx) which screen is shown and what it says. Both go through the tab's askAgent (#1150): the
// conversation itself happens in the tab's terminal, with the developer's coding agent. Outside the tab there is
// nowhere to ask: the buttons are not shown.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { createContext, useContext, useEffect } from "react";
import { getLocale, useT } from "../i18n/i18n";
import { useAskAgent } from "./pipeline-tab-context";
import { AskAgent, helpContextOf, HelpScreen, HelpStep, SetupHelp } from "./release-setup-help-model";

export type HelpScopeValue = {
    dir: string;
    screen: HelpScreen;
    // What the panel shows, in plain words.
    context?: string;
    // The tab's askAgent (#1150), read from the tab when not given.
    askAgent?: AskAgent;
};

const HelpScopeContext = createContext<HelpScopeValue>(null);

// Tells the panel's "Ask for help" which screen is shown and what it says.
export function useHelpScreenInfo(dir: string, screen: HelpScreen, context: string) {
    useEffect(() => {
        if (!dir) {
            return;
        }
        globalStore.set(SetupHelp.getInstance(dir).screenAtom, { screen, panel: context ?? "" });
    }, [dir, screen, context]);
}

export function HelpScope({ children, ...value }: HelpScopeValue & { children: React.ReactNode }) {
    useHelpScreenInfo(value.dir, value.screen, value.context);
    return <HelpScopeContext.Provider value={value}>{children}</HelpScopeContext.Provider>;
}

function useScope(props: Partial<HelpScopeValue>): HelpScopeValue {
    const scope = useContext(HelpScopeContext) ?? { dir: "", screen: "flow" };
    const tabAsk = useAskAgent();
    return {
        dir: props.dir ?? scope.dir,
        screen: props.screen ?? scope.screen,
        context: props.context ?? scope.context,
        askAgent: props.askAgent ?? scope.askAgent ?? tabAsk,
    };
}

const GhostButton =
    "cursor-pointer rounded-4 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// A step's "Question": the agent gets the step and the panel's context; the developer asks in the terminal. What
// became of the request shows beside the panel's "Ask for help".
export function QuestionButton({ step, ...props }: { step: HelpStep } & Partial<HelpScopeValue>) {
    const t = useT();
    const scope = useScope(props);
    const status = useAtomValue(SetupHelp.getInstance(scope.dir).statusAtom, { store: globalStore });
    if (!scope.askAgent) {
        return null;
    }
    const ask = () => {
        const context = helpContextOf({ locale: getLocale(), screen: scope.screen, step, panel: scope.context });
        fireAndForget(() => SetupHelp.getInstance(scope.dir).ask(scope.askAgent, context));
    };
    return (
        <button
            type="button"
            className={GhostButton}
            onClick={ask}
            disabled={!scope.dir || status === "asking"}
            title={t("mc.setup.help.questionTitle")}
            data-testid="setup-question-button"
        >
            {t("mc.setup.help.question")}
        </button>
    );
}
