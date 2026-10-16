// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2, "Your first morph" (FR-ONB-003, DS-ONB-003): the core idea working on the user's machine. The step starts the
// agent chosen in step 1 in a terminal beside the panel, in a scratch folder (<data>/molten/first-morph), proposes a
// small, read-only request in that agent's syntax, and ticks once a mod is enabled. Without an agent, it shows the
// built-in copy box, the first morph MoltenTerm ships.

import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { MoltenHost } from "../molten/molten-host";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { serverErrorText } from "../moltenterm-shell/i18n/server-text";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { OnboardingAgents } from "./onboarding-agent-model";
import { ensureMorphDir, listOnboardingAgents } from "./onboarding-client";
import {
    CopyDemoCommand,
    CopyDemoText,
    CopyDemoTitle,
    enabledModIds,
    morphAgent,
    MorphBaselineKey,
    MorphedMod,
    MorphModKey,
    morphRequests,
    MorphTermKey,
    newMod,
    readMorphedMod,
} from "./onboarding-morph-model";
import { CopyLine, StepText, withCodes } from "./onboarding-parts";
import type { FirstRunStepContext } from "./onboarding-steps";

function blockInLayout(blockId: string): boolean {
    if (!blockId) {
        return false;
    }
    return getLayoutModelForStaticTab()?.getNodeByBlockId(blockId) != null;
}

function focusBlock(blockId: string) {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(blockId);
    if (node != null) {
        layoutModel.focusNode(node.id);
    }
}

// The palette's agent start, loaded on use: palette-actions opens Getting started, so a static import would loop
// back into the steps list.
async function typeCommand(blockId: string, command: string): Promise<boolean> {
    const { typeCommandWhenReady } = await import("../moltenterm-shell/palette/palette-actions");
    return typeCommandWhenReady(blockId, command);
}

function MorphDone({ mod, onNext }: { mod: MorphedMod; onNext: () => void }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-3" data-testid="first-run-morph-done">
            <div className="flex items-center gap-2 text-13 font-medium text-primary">
                <i className="fa-solid fa-circle-check text-[var(--mt-state-done)]" aria-hidden />
                {t("onboarding.morph.doneTitle", { name: mod.name })}
            </div>
            {mod.commands.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <StepText>{t("onboarding.morph.callIt")}</StepText>
                    {mod.commands.map((command) => (
                        <CopyLine key={command} text={`molten ${command}`} />
                    ))}
                </div>
            ) : (
                <StepText>{withCodes(t("onboarding.morph.commandsLater"), { command: "molten mod list" })}</StepText>
            )}
            <StepText>{withCodes(t("onboarding.morph.undo"), { command: "molten undo" })}</StepText>
            <div>
                <button
                    type="button"
                    onClick={onNext}
                    className="molten-btn cursor-pointer rounded-6 px-4 py-1.5 text-12 font-medium"
                    data-testid="first-run-morph-next"
                >
                    {t("onboarding.footer.next")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

function CopyBoxDemo({ ctx }: { ctx: FirstRunStepContext }) {
    const t = useT();
    const [shown, setShown] = useState(false);
    const [error, setError] = useState<string>(null);
    const show = async () => {
        setError(null);
        const result = await MoltenHost.getInstance().runCommand({
            command: "copy",
            args: ["--title", CopyDemoTitle, CopyDemoText],
            blockid: ctx.panelBlockId,
        });
        if (!result.found || result.exitcode !== 0) {
            setError(result.error || result.output || t("onboarding.morph.copyBoxMissing"));
            return;
        }
        setShown(true);
    };
    return (
        <div className="flex flex-col gap-3" data-testid="first-run-morph-noagent">
            <StepText>
                {withCodes(t("onboarding.morph.noAgentIntro"), { morph: "/morph", undo: "molten undo" })}
            </StepText>
            <StepText>{t("onboarding.morph.copyBoxIntro")}</StepText>
            <CopyLine text={CopyDemoCommand} />
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => fireAndForget(show)}
                    className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="first-run-copy-demo"
                >
                    {t("onboarding.morph.showCopyBox")}
                </button>
                {shown ? <span className="text-12 text-secondary">{t("onboarding.morph.copyBoxShown")}</span> : null}
            </div>
            {error ? <p className="text-12 text-error">{error}</p> : null}
            <StepText className="text-12 text-muted">{t("onboarding.morph.installAgent")}</StepText>
        </div>
    );
}

export function MorphStep({ ctx }: { ctx: FirstRunStepContext }) {
    const t = useT();
    const host = MoltenHost.getInstance();
    const mods = useAtomValue(host.modsAtom, { store: globalStore });
    const [list, setList] = useState<OnboardingAgents>(null);
    const [error, setError] = useState<string>(null);
    const [opening, setOpening] = useState(false);
    const recording = useRef(false);

    useEffect(() => {
        listOnboardingAgents().then(setList, (e) =>
            setError(t("onboarding.agent.listFailed", { error: serverErrorText(e) }))
        );
    }, []);

    const agent = morphAgent(ctx.state, list);
    const recorded = readMorphedMod(ctx.data);
    const baseline: string[] = ctx.data?.[MorphBaselineKey];
    const termId: string = ctx.data?.[MorphTermKey];
    const hasBaseline = Array.isArray(baseline);

    // The mods enabled when the step first shows are not the user's first morph: only one enabled after it ticks the
    // step, from the step's terminal or any other. The host's list is complete once it has loaded.
    useEffect(() => {
        if (hasBaseline) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            await host.whenLoaded();
            if (!cancelled) {
                await ctx.setData({ [MorphBaselineKey]: enabledModIds(globalStore.get(host.modsAtom)) });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [hasBaseline, host, ctx]);

    useEffect(() => {
        if (recorded != null || recording.current) {
            return;
        }
        const mod = newMod(mods, baseline);
        if (mod == null) {
            return;
        }
        recording.current = true;
        fireAndForget(async () => {
            try {
                await ctx.setData({ [MorphModKey]: mod });
                await ctx.markDone();
            } finally {
                recording.current = false;
            }
        });
    }, [mods, baseline, recorded, ctx]);

    if (list == null) {
        return error ? (
            <p className="text-13 text-error">{error}</p>
        ) : (
            <StepText>{t("onboarding.morph.preparing")}</StepText>
        );
    }
    if (recorded != null) {
        return <MorphDone mod={recorded} onNext={() => fireAndForget(ctx.complete)} />;
    }
    if (agent == null) {
        return <CopyBoxDemo ctx={ctx} />;
    }

    const termOpen = blockInLayout(termId);
    const open = async () => {
        if (termOpen) {
            focusBlock(termId);
            return;
        }
        setOpening(true);
        setError(null);
        try {
            const dir = await ensureMorphDir();
            const blockId = await ctx.openBeside({ meta: { view: "term", controller: "shell", "cmd:cwd": dir } });
            await ctx.setData({ [MorphTermKey]: blockId });
            if (!(await typeCommand(blockId, agent.executable))) {
                setError(t("onboarding.morph.termFailed", { command: agent.executable }));
            }
        } catch (e) {
            setError(serverErrorText(e));
        } finally {
            setOpening(false);
        }
    };
    const [first, ...alternatives] = morphRequests(agent);

    return (
        <div className="flex flex-col gap-4" data-testid="first-run-morph">
            <StepText>{t("onboarding.morph.intro", { name: agent.name })}</StepText>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    disabled={opening}
                    onClick={() => fireAndForget(open)}
                    className="molten-btn cursor-pointer rounded-6 px-4 py-1.5 text-12 font-medium"
                    data-testid="first-run-open-agent"
                >
                    {termOpen
                        ? t("onboarding.morph.goTo", { name: agent.name })
                        : t("onboarding.morph.openBeside", { name: agent.name })}
                    <MoltenWave />
                </button>
            </div>
            <div className="flex flex-col gap-1.5">
                <span className="text-12 font-medium text-secondary">{t("onboarding.morph.firstRequest")}</span>
                <CopyLine text={first} testId="first-run-morph-request" />
            </div>
            <div className="flex flex-col gap-1.5">
                <span className="text-12 text-muted">{t("onboarding.morph.alternatives")}</span>
                {alternatives.map((request) => (
                    <CopyLine key={request} text={request} />
                ))}
            </div>
            <StepText className="text-12 text-muted">
                {withCodes(t("onboarding.morph.waiting"), { command: "molten undo" })}
            </StepText>
            {error ? (
                <p className="text-12 text-error" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
