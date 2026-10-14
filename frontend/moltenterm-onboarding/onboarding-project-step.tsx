// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 3, "Your project and your sessions" (FR-ONB-004, DS-ONB-004): the workspace becomes the user's project, and
// they learn their sessions survive. Choosing a folder sets the workspace folder (FR-SHELL-009) with the project's
// name and a colour, links a git repository as the workspace's project (FR-MC-001), and offers /molten-pipeline to
// connect it to Mission Control. The repositories under the home folder are looked for on request only: on macOS,
// reading Documents or Desktop the first time asks the user, which must not happen unasked in the middle of a step.

import { atoms } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { focusMoltentermView } from "../moltenterm-shell/open-view";
import { MoltentermSessionsView } from "../moltenterm-shell/sessions/sessions-model";
import { openWorkspaceEditor } from "../moltenterm-shell/workspace-edit";
import { readRecentFolders, readWorkspaceFolder } from "../moltenterm-shell/workspace-project";
import {
    chooseMoltentermPath,
    findProjectRoot,
    linkWorkspaceProject,
    readProjectFacts,
    setWorkspaceFolder,
} from "../moltenterm-shell/workspace-project-store";
import { ChosenAgentKey, genericAgent, OnboardingAgents } from "./onboarding-agent-model";
import { listOnboardingAgents, scanProjectCandidates } from "./onboarding-client";
import { Code, CopyLine, StepText, withCodes } from "./onboarding-parts";
import {
    pipelineCall,
    ProjectCandidate,
    projectCandidates,
    projectColour,
    ProjectFolderKey,
} from "./onboarding-project-model";
import type { FirstRunStepContext } from "./onboarding-steps";

type FolderFacts = { folder: string; repo: string; hasPipeline: boolean; name: string };

function SectionTitle({ children }: { children: React.ReactNode }) {
    return <h3 className="text-13 font-semibold text-primary">{children}</h3>;
}

function CandidateList({
    candidates,
    current,
    busy,
    onPick,
}: {
    candidates: ProjectCandidate[];
    current: string;
    busy: boolean;
    onPick: (path: string) => void;
}) {
    if (candidates.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-col divide-y divide-border rounded-4 border border-border">
            {candidates.map((c) => (
                <li key={c.path}>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onPick(c.path)}
                        className={cn(
                            "flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-hover",
                            c.path === current && "bg-hover"
                        )}
                        data-project-candidate={c.path}
                    >
                        <i
                            className={cn("fa-solid text-muted", c.recent ? "fa-clock-rotate-left" : "fa-code-branch")}
                            aria-hidden
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-13 text-primary">{c.name}</span>
                            <span className="truncate text-12 text-muted">{c.path}</span>
                        </span>
                        {c.path === current ? (
                            <i className="fa-solid fa-circle-check text-[var(--mt-state-done)]" aria-hidden />
                        ) : null}
                    </button>
                </li>
            ))}
        </ul>
    );
}

function MissionControlOffer({ facts, call }: { facts: FolderFacts; call: string }) {
    const t = useT();
    if (facts == null) {
        return null;
    }
    if (!facts.repo) {
        return <StepText className="text-12 text-muted">{t("onboarding.project.notRepo")}</StepText>;
    }
    if (facts.hasPipeline) {
        return (
            <StepText testId="first-run-pipeline-linked">
                <i className="fa-solid fa-circle-check mr-1.5 text-[var(--mt-state-done)]" aria-hidden />
                {withCodes(t("onboarding.project.connected", { name: facts.name }), { file: ".molten/project.json" })}
            </StepText>
        );
    }
    return (
        <div className="flex flex-col gap-1.5" data-testid="first-run-pipeline-offer">
            <StepText>
                {withCodes(t("onboarding.project.connect", { name: facts.name }), { file: ".molten/project.json" })}
            </StepText>
            <CopyLine text={call} />
        </div>
    );
}

// The tab's Sessions view gets the focus, else one opens beside the guide.
async function openSessions(ctx: FirstRunStepContext): Promise<void> {
    if (await focusMoltentermView(MoltentermSessionsView)) {
        return;
    }
    await ctx.openBeside({ meta: { view: MoltentermSessionsView } });
}

function SessionsPanel({ ctx }: { ctx: FirstRunStepContext }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-2 rounded-4 border border-border px-3 py-2.5">
            <SectionTitle>{t("onboarding.project.sessionsTitle")}</SectionTitle>
            <StepText>{t("onboarding.project.sessionsText")}</StepText>
            <div>
                <button
                    type="button"
                    onClick={() => fireAndForget(() => openSessions(ctx))}
                    className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="first-run-open-sessions"
                >
                    {t("onboarding.project.openSessions")}
                </button>
            </div>
        </div>
    );
}

export function ProjectStep({ ctx }: { ctx: FirstRunStepContext }) {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const [scanned, setScanned] = useState<ProjectCandidate[]>(null);
    const [agents, setAgents] = useState<OnboardingAgents>(null);
    const [facts, setFacts] = useState<FolderFacts>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);

    const folder = readWorkspaceFolder(ws) || ctx.data?.[ProjectFolderKey] || "";

    useEffect(() => {
        listOnboardingAgents().then(setAgents, () => setAgents({ agents: [], version: "" }));
    }, []);

    useEffect(() => {
        if (!folder) {
            setFacts(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const repo = await findProjectRoot(folder);
            const projectFacts = await readProjectFacts(repo || folder);
            if (!cancelled) {
                setFacts({ folder, repo, hasPipeline: projectFacts.hasPipeline, name: projectFacts.name });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [folder]);

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(`${e?.message ?? e}`);
        } finally {
            setBusy(false);
        }
    };

    const pick = (path: string) =>
        run(async () => {
            if (ws == null || !path) {
                return;
            }
            await setWorkspaceFolder(ws.oid, path);
            const repo = await findProjectRoot(path);
            if (repo) {
                await linkWorkspaceProject(ws, repo);
            }
            const { name } = await readProjectFacts(repo || path);
            await WorkspaceService.UpdateWorkspace(ws.oid, name, ws.icon ?? "", projectColour(name), !ws.icon);
            await ctx.setData({ [ProjectFolderKey]: path });
        });

    const choose = () =>
        run(async () => {
            const path = await chooseMoltentermPath({
                kind: "folder",
                title: t("onboarding.project.folderTitle"),
                defaultPath: folder || undefined,
            });
            if (path) {
                await pick(path);
            }
        });

    const scan = () =>
        run(async () => {
            setScanned(await scanProjectCandidates());
        });

    const candidates = projectCandidates(readRecentFolders(ws), scanned ?? []);
    const chosenId = ctx.state?.data?.agent?.[ChosenAgentKey];
    const chosen = agents?.agents?.find((a) => a.id === chosenId && a.found);
    const call = pipelineCall(chosen, genericAgent(agents));

    return (
        <div className="flex flex-col gap-5" data-testid="first-run-project">
            <div className="flex flex-col gap-2">
                <SectionTitle>{t("onboarding.project.folderTitle")}</SectionTitle>
                <StepText>{t("onboarding.project.folderText")}</StepText>
                {folder ? (
                    <StepText testId="first-run-project-folder">
                        <i className="fa-solid fa-folder mr-1.5 text-muted" aria-hidden />
                        <Code>{folder}</Code>
                        {ws != null ? (
                            <button
                                type="button"
                                onClick={() => openWorkspaceEditor(ws.oid)}
                                className="ml-2 cursor-pointer text-12 text-accent hover:underline"
                            >
                                {t("onboarding.project.editWorkspace")}
                            </button>
                        ) : null}
                    </StepText>
                ) : null}
                <CandidateList
                    candidates={candidates}
                    current={folder}
                    busy={busy}
                    onPick={(p) => fireAndForget(() => pick(p))}
                />
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => fireAndForget(choose)}
                        className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    >
                        {t("onboarding.project.chooseFolder")}
                    </button>
                    {scanned == null ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => fireAndForget(scan)}
                            className="molten-btn-ghost cursor-pointer rounded-6 px-3 py-1.5 text-12"
                            data-testid="first-run-scan-projects"
                        >
                            {t("onboarding.project.scan")}
                        </button>
                    ) : scanned.length === 0 ? (
                        <span className="text-12 text-muted">{t("onboarding.project.scanEmpty")}</span>
                    ) : null}
                </div>
            </div>
            <MissionControlOffer facts={facts} call={call} />
            <SessionsPanel ctx={ctx} />
            {error ? (
                <p className="text-12 text-error" role="alert">
                    {error}
                </p>
            ) : null}
            <div>
                <button
                    type="button"
                    disabled={busy || !folder}
                    onClick={() => fireAndForget(ctx.complete)}
                    className="molten-btn cursor-pointer rounded-6 px-4 py-1.5 text-12 font-medium"
                    data-testid="first-run-project-done"
                >
                    {t(folder ? "onboarding.project.done" : "onboarding.project.chooseFirst")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}
