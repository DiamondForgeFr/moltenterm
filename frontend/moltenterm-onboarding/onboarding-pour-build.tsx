// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The scenes of the pour where the user sets the workshop up (#1709): the project (FR-ONB-007 P-4), the first view
// and its place (FR-ONB-009), and the last one, ready (P-6). Each takes what it shows as props, so they render
// without a window in tests; onboarding-pour.tsx holds the state and onboarding-view.tsx does the work.

import { cn, makeIconClass } from "@/util/util";
import { useEffect, useRef } from "react";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { formatShortcutById } from "../moltenterm-shell/shortcuts/format";
import { ViewSuggestions } from "../moltenterm-shell/workspace-views/view-suggestions";
import type { OnboardingAgent } from "./onboarding-agent-model";
import {
    cleanFolderName,
    FirstViewTools,
    matchingSuggestion,
    ProjectDraft,
    ProjectResult,
    projectTarget,
    shownPath,
    ViewPlace,
} from "./onboarding-first-view-model";
import { withCodes } from "./onboarding-parts";
import "./onboarding-pour-build.css";
import { PourMark } from "./onboarding-pour-scenes";
import { ProjectCandidate, projectColour, WorkspaceColours } from "./onboarding-project-model";

// The workspace a project becomes, as its chip shows it.
export type ProjectChip = { name: string; colour: string };

const PourStaggerMs = 350;
const PourFirstDelayMs = 300;
const DayMs = 24 * 60 * 60 * 1000;
// The sample workspace the place scene shows next to the user's: a next one, empty of views of its own.
const NextWorkspaceColour = WorkspaceColours[5];

function Title({ a, b }: { a: string; b: string }) {
    return (
        <h1>
            {a} <span className="mt-pour-hot">{b}</span>
        </h1>
    );
}

// A folder's name as the workspace takes it when nothing in the project names it otherwise (readProjectFacts): the
// folder's own name, so the chip shows the name and colour the workspace gets.
export function previewName(folder: string): string {
    return (
        (folder ?? "")
            .replace(/[/\\]+$/, "")
            .split(/[/\\]/)
            .pop() ?? ""
    );
}

export function chipOf(path: string): ProjectChip {
    const name = previewName(path);
    return name ? { name, colour: projectColour(name) } : null;
}

function ago(modtime: number, now: number, t: (key: string, vars?: Record<string, any>) => string): string {
    if (!modtime) {
        return "";
    }
    const days = Math.floor((now - modtime) / DayMs);
    if (days <= 0) {
        return t("onboarding.pour.project.today");
    }
    return t(days === 1 ? "onboarding.pour.project.dayAgo" : "onboarding.pour.project.daysAgo", { n: days });
}

// Scene 3, your project (P-4): create a folder, or find one already on this computer. Leaving the scene creates or
// links it; nothing happens on this computer before.
export function ProjectScene({
    draft,
    home,
    candidates,
    scanning,
    now,
    onPatch,
    onChooseWhere,
    onLookElsewhere,
}: {
    draft: ProjectDraft;
    home: string;
    candidates: ProjectCandidate[];
    scanning: boolean;
    now: number;
    onPatch: (patch: Partial<ProjectDraft>) => void;
    onChooseWhere: () => void;
    onLookElsewhere: () => void;
}) {
    const t = useT();
    const p = "onboarding.pour.project";
    const target = projectTarget(draft);
    const chip = chipOf(target);
    const name = cleanFolderName(draft.name);
    return (
        <div className="mt-pour-inner" data-testid="pour-project">
            <div className="mt-pour-kicker">{t(`${p}.kicker`)}</div>
            <Title a={t(`${p}.titleA`)} b={t(`${p}.titleB`)} />
            <div className="mt-pb-choices" role="group" aria-label={t(`${p}.kicker`)}>
                {(["new", "find"] as const).map((mode) => (
                    <button
                        key={mode}
                        type="button"
                        className="mt-pb-choice cursor-pointer"
                        aria-pressed={draft.mode === mode}
                        onClick={() => onPatch({ mode })}
                        data-testid={`pour-project-${mode}`}
                    >
                        <b>{t(`${p}.${mode}.title`)}</b>
                        <span>{t(`${p}.${mode}.text`)}</span>
                    </button>
                ))}
            </div>
            <div className="mt-pb-pane">
                {draft.mode === "new" ? (
                    <>
                        <div className="mt-pb-row">
                            <label className="mt-pour-lbl" htmlFor="mt-pb-name">
                                {t(`${p}.new.name`)}
                            </label>
                            <input
                                id="mt-pb-name"
                                className="mt-pb-field"
                                value={draft.name}
                                placeholder={t(`${p}.new.placeholder`)}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => onPatch({ name: e.target.value })}
                                data-testid="pour-project-name"
                            />
                        </div>
                        <div className="mt-pb-row">
                            <span className="mt-pour-lbl">{t(`${p}.new.in`)}</span>
                            <span
                                className="mt-pb-field"
                                data-mono=""
                                title={draft.location}
                                data-testid="pour-project-in"
                            >
                                {shownPath(draft.location, home)}
                            </span>
                            <button
                                type="button"
                                className="mt-pb-small cursor-pointer"
                                onClick={onChooseWhere}
                                data-testid="pour-project-where"
                            >
                                {t(`${p}.new.where`)}
                            </button>
                        </div>
                        <div className="mt-pb-row">
                            <span className="mt-pour-lbl" />
                            <label className="mt-pb-check cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="cursor-pointer"
                                    checked={draft.git}
                                    onChange={(e) => onPatch({ git: e.target.checked })}
                                    data-testid="pour-project-git"
                                />
                                {t(`${p}.new.git`)}
                            </label>
                        </div>
                        <div className="mt-pb-row">
                            <span className="mt-pour-lbl" />
                            <span className="mt-pb-note" aria-live="polite">
                                {name
                                    ? t(draft.git ? `${p}.new.willGit` : `${p}.new.will`, {
                                          path: shownPath(target, home),
                                      })
                                    : t(`${p}.new.nameFirst`)}
                            </span>
                        </div>
                    </>
                ) : (
                    <>
                        <span className="mt-pour-lbl">{t(`${p}.find.found`)}</span>
                        <div className="mt-pb-found" data-testid="pour-project-found">
                            {candidates.map((c) => (
                                <button
                                    key={c.path}
                                    type="button"
                                    className="mt-pb-proj cursor-pointer"
                                    aria-pressed={draft.found === c.path}
                                    onClick={() => onPatch({ found: c.path })}
                                    data-path={c.path}
                                >
                                    <i style={{ background: projectColour(previewName(c.path)) }} />
                                    <span className="min-w-0">
                                        <b>{c.name}</b>
                                        <small>{shownPath(c.path, home)}</small>
                                    </span>
                                    <em>
                                        {c.recent
                                            ? t(`${p}.find.recent`)
                                            : [t(`${p}.find.repo`), ago(c.modtime, now, t)].filter(Boolean).join(" · ")}
                                    </em>
                                </button>
                            ))}
                            {candidates.length === 0 ? (
                                <span className="mt-pb-note">
                                    {t(scanning ? `${p}.find.scanning` : `${p}.find.none`)}
                                </span>
                            ) : null}
                        </div>
                        <div className="mt-pb-row justify-between">
                            <span className="mt-pb-note">{t(`${p}.find.hint`)}</span>
                            <button
                                type="button"
                                className="mt-pb-small cursor-pointer"
                                onClick={onLookElsewhere}
                                data-testid="pour-project-elsewhere"
                            >
                                {t(`${p}.find.elsewhere`)}
                            </button>
                        </div>
                    </>
                )}
            </div>
            <div className="mt-pb-wsprev">
                {t(`${p}.chip`)}
                {chip ? (
                    <span key={chip.name} className="mt-pb-chip" data-testid="pour-project-chip">
                        <i style={{ background: chip.colour }} />
                        {chip.name}
                    </span>
                ) : (
                    <span className="mt-pb-note">{t(`${p}.chipNone`)}</span>
                )}
            </div>
        </div>
    );
}

// A sample sidebar, as the app draws it: the top row (empty on a fresh install), the workspace, its tiles or its
// empty state, the temporary views and the bottom bar.
export function SampleSidebar({
    project,
    mineTop,
    mineTile,
    temp,
    dots,
    on,
}: {
    project: ProjectChip;
    mineTop?: string;
    mineTile?: string;
    temp?: string;
    dots: string[];
    on: number;
}) {
    const t = useT();
    const s = "onboarding.pour.view.sample";
    return (
        <div className="mt-pb-sb" style={{ "--ws": project.colour } as React.CSSProperties}>
            <div className="mt-pb-tfield">
                <i className="fa-solid fa-magnifying-glass" />
                {t(`${s}.search`)}
            </div>
            {mineTop ? (
                <div className="mt-pb-toprow" style={{ gridTemplateColumns: "1fr" }}>
                    <span key={mineTop} className="mt-pb-mine">
                        {mineTop}
                    </span>
                </div>
            ) : (
                <div className="mt-pb-toprow" data-empty="">
                    <span>{t(`${s}.topEmpty`)}</span>
                </div>
            )}
            <div className="mt-pb-wsh">
                <i style={{ background: project.colour }} />
                <span className="truncate">{project.name}</span>
            </div>
            {mineTile ? (
                <div className="mt-pb-tiles">
                    <span key={mineTile} className="mt-pb-tile mt-pb-mine">
                        <i className="fa-solid fa-table-cells-large" /> {mineTile}
                    </span>
                </div>
            ) : (
                <div className="mt-pb-empty">{t(`${s}.empty`, { keys: formatShortcutById("new-tab") })}</div>
            )}
            {temp ? <div className="mt-pb-newv">◌ {temp}</div> : null}
            <div className="mt-pb-newv">{t(`${s}.newView`)}</div>
            <div className="mt-pb-bbar">
                <i className="fa-solid fa-box-archive" />
                <span className="mt-pb-dots">
                    {dots.map((c, i) => (
                        <i key={i} data-on={i === on ? "" : undefined} style={{ "--c": c } as React.CSSProperties} />
                    ))}
                </span>
                <span>+</span>
            </div>
        </div>
    );
}

function PanelBody({ kind }: { kind: string }) {
    const t = useT();
    const s = "onboarding.pour.view.sample";
    switch (kind) {
        case "browser":
            return (
                <>
                    <div className="mt-pb-ph w-3/5" />
                    <div className="mt-pb-ph w-4/5" />
                    <div className="mt-pb-ph w-2/5" />
                </>
            );
        case "files":
            return (
                <div className="mt-pb-fl">
                    ▸ src
                    <br />▸ docs
                    <br />
                    &nbsp; README.md
                </div>
            );
        case "integration":
            return (
                <>
                    <div className="mt-pb-pr">
                        <i style={{ background: "var(--pour-hot)" }} />
                        {t(`${s}.ci`)}
                    </div>
                    <div className="mt-pb-pr">
                        <i style={{ background: "var(--pour-ready)" }} />
                        {t(`${s}.pr`)}
                    </div>
                </>
            );
        case "project":
            return (
                <>
                    <div className="mt-pb-pr">
                        <i style={{ background: "var(--pour-ready)" }} />
                        {t(`${s}.branch`)}
                    </div>
                    <div className="mt-pb-ph w-3/5" />
                </>
            );
    }
    return null;
}

// Scene 4, your first view (FR-ONB-009): the agent on the left, up to three tools on the right, the ready-made
// combinations, and the view assembling live. Nothing starts: the agent's place only says what a click will start.
export function FirstViewScene({
    tools,
    name,
    named,
    agents,
    agentId,
    project,
    reduced,
    onTool,
    onPreset,
    onName,
    onAgent,
    onPoured,
}: {
    tools: string[];
    // the name as shown: the typed one, or the suggestion's in the interface language
    name: string;
    named: boolean;
    agents: OnboardingAgent[];
    agentId: string;
    project: ProjectChip;
    reduced: boolean;
    onTool: (kind: string) => void;
    onPreset: (id: string) => void;
    onName: (text: string) => void;
    onAgent: (id: string) => void;
    onPoured?: (el: Element) => void;
}) {
    const t = useT();
    const v = "onboarding.pour.view";
    const right = useRef<HTMLDivElement>(null);
    const first = useRef(new Set(tools));
    const before = useRef(tools);
    const agent = agents.find((a) => a.id === agentId);
    const preset = matchingSuggestion(tools);

    // A tool turned on pours in with sparks; the ones of the first showing pour one after the other.
    useEffect(() => {
        const added = tools.filter((k) => !before.current.includes(k));
        before.current = tools;
        if (reduced || added.length === 0) {
            return;
        }
        const el = right.current?.querySelector(`[data-panel="${added[added.length - 1]}"]`);
        if (el != null) {
            onPoured?.(el);
        }
    }, [tools, reduced]);

    return (
        <div className="mt-pour-inner" data-testid="pour-view">
            <div className="mt-pour-kicker">{t(`${v}.kicker`)}</div>
            <Title a={t(`${v}.titleA`)} b={t(`${v}.titleB`)} />
            <p className="mt-pour-sub">{t(`${v}.sub`)}</p>
            <div className="mt-pb-builder">
                <div className="mt-pb-tools">
                    <span className="mt-pour-lbl">{t(`${v}.left`)}</span>
                    <div className="mt-pb-agents" data-testid="pour-view-agents">
                        {agents.length > 1 ? (
                            agents.map((a) => (
                                <button
                                    key={a.id}
                                    type="button"
                                    className="cursor-pointer"
                                    aria-pressed={a.id === agentId}
                                    onClick={() => onAgent(a.id)}
                                    data-agent={a.id}
                                >
                                    <span className="mt-pb-gl">❯</span>
                                    {a.name}
                                </button>
                            ))
                        ) : (
                            <span>
                                <span className="mt-pb-gl">❯</span>
                                {agent?.name ?? t(`${v}.agentLater`)}
                            </span>
                        )}
                    </div>
                    <span className="mt-pour-lbl">{t(`${v}.right`)}</span>
                    <div className="mt-pb-toggles" data-testid="pour-view-tools">
                        {FirstViewTools.map((tool) => (
                            <button
                                key={tool.kind}
                                type="button"
                                className="mt-pb-tog cursor-pointer"
                                aria-pressed={tools.includes(tool.kind)}
                                onClick={() => onTool(tool.kind)}
                                data-tool={tool.kind}
                            >
                                <i className={makeIconClass(tool.icon, true)} />
                                {t(tool.labelKey)}
                                <small>{t(`${v}.hints.${tool.kind}`)}</small>
                            </button>
                        ))}
                    </div>
                    <span className="mt-pour-lbl">{t(`${v}.presets`)}</span>
                    <div className="mt-pb-suggest" data-testid="pour-view-presets">
                        {ViewSuggestions.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                className="cursor-pointer"
                                aria-pressed={!named && preset === s.id}
                                onClick={() => onPreset(s.id)}
                                data-preset={s.id}
                            >
                                {t(s.nameKey)}
                            </button>
                        ))}
                    </div>
                    <div className="mt-pb-namerow">
                        <label className="mt-pour-lbl" htmlFor="mt-pb-vname">
                            {t(`${v}.name`)}
                        </label>
                        <input
                            id="mt-pb-vname"
                            className="mt-pb-field"
                            value={name}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) => onName(e.target.value)}
                            data-testid="pour-view-name"
                        />
                    </div>
                </div>
                <div className="mt-pb-win" style={{ "--ws": project.colour } as React.CSSProperties} aria-hidden>
                    <SampleSidebar project={project} temp={name || t(`${v}.unnamed`)} dots={[project.colour]} on={0} />
                    <div className="mt-pb-vw">
                        <div className="mt-pb-tabname">
                            <i className="fa-solid fa-table-cells-large" />
                            <b>{name || t(`${v}.unnamed`)}</b>
                            <em>{t(`${v}.temporary`)}</em>
                        </div>
                        <div className="mt-pb-grid">
                            <div className="mt-pb-slot">
                                <span>{t(`${v}.slot`)}</span>
                                <b data-testid="pour-view-start">
                                    {agent ? t(`${v}.start`, { agent: agent.name }) : t(`${v}.startAny`)}
                                </b>
                            </div>
                            <div ref={right} className="mt-pb-right">
                                {tools.length === 0 ? (
                                    <div className="mt-pb-noright">{t(`${v}.noTools`)}</div>
                                ) : (
                                    tools.map((kind, i) => {
                                        const tool = FirstViewTools.find((x) => x.kind === kind);
                                        const initial = first.current.has(kind);
                                        return (
                                            <div
                                                key={kind}
                                                className="mt-pb-panel"
                                                data-panel={kind}
                                                data-pour=""
                                                style={{
                                                    animationDelay: initial
                                                        ? `${PourFirstDelayMs + i * PourStaggerMs}ms`
                                                        : "0ms",
                                                }}
                                            >
                                                <header>
                                                    <i className={makeIconClass(tool.icon, true)} />
                                                    {t(tool.labelKey)}
                                                </header>
                                                <PanelBody kind={kind} />
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Scene 5, its place (FR-ONB-009): available in every workspace, or pinned in this one only; two sample sidebars
// show the difference.
export function PlaceScene({
    name,
    place,
    project,
    onPlace,
}: {
    name: string;
    place: ViewPlace;
    project: ProjectChip;
    onPlace: (place: ViewPlace) => void;
}) {
    const t = useT();
    const w = "onboarding.pour.place";
    const other: ProjectChip = {
        name: t(`${w}.next`),
        colour: project.colour === NextWorkspaceColour ? WorkspaceColours[2] : NextWorkspaceColour,
    };
    const every = place === "everywhere";
    const dots = [project.colour, other.colour];
    return (
        <div className="mt-pour-inner" data-testid="pour-place">
            <div className="mt-pour-kicker">{t(`${w}.kicker`)}</div>
            <h1>
                {t(`${w}.titleA`)} <span className="mt-pour-hot">{name}</span>
                {t(`${w}.titleB`)}
            </h1>
            <div className="mt-pb-choices" role="group" aria-label={t(`${w}.kicker`)}>
                <button
                    type="button"
                    className="mt-pb-choice cursor-pointer"
                    aria-pressed={every}
                    onClick={() => onPlace("everywhere")}
                    data-place="everywhere"
                >
                    <b>{t(`${w}.everywhere.title`)}</b>
                    <span>{t(`${w}.everywhere.text`)}</span>
                </button>
                <button
                    type="button"
                    className="mt-pb-choice cursor-pointer"
                    aria-pressed={!every}
                    onClick={() => onPlace("workspace")}
                    data-place="workspace"
                >
                    <b>{t(`${w}.workspace.title`, { workspace: project.name })}</b>
                    <span>{t(`${w}.workspace.text`)}</span>
                </button>
            </div>
            <p className="mt-pb-editable">{t(`${w}.editable`)}</p>
            <div className="mt-pb-two" aria-hidden>
                <div>
                    <div className="mt-pb-mini">
                        <SampleSidebar
                            project={project}
                            mineTop={every ? name : null}
                            mineTile={every ? null : name}
                            dots={dots}
                            on={0}
                        />
                    </div>
                    <div className="mt-pb-cap">{t(`${w}.capMine`, { workspace: project.name })}</div>
                </div>
                <div>
                    <div className="mt-pb-mini" data-dim="">
                        <SampleSidebar project={other} mineTop={every ? name : null} dots={dots} on={1} />
                    </div>
                    <div className="mt-pb-cap">{t(`${w}.capNext`, { workspace: other.name })}</div>
                </div>
            </div>
            <p className="mt-pb-legend" aria-live="polite">
                {t(every ? `${w}.legendEverywhere` : `${w}.legendWorkspace`, {
                    name,
                    workspace: project.name,
                    other: other.name,
                })}
            </p>
        </div>
    );
}

export type ReadyRecap = {
    project: ProjectResult;
    // the view made at the end, or null when it was left for later
    view: { name: string; parts: string } | null;
    place: ViewPlace;
    workspace: string;
};

// Scene 6, ready (P-6): what was set, the one line on /morph and the Library, and how the next views are made.
export function ReadyScene({ markPath, recap }: { markPath: string; recap: ReadyRecap }) {
    const t = useT();
    const r = "onboarding.pour.start";
    const keys = formatShortcutById("new-tab");
    return (
        <div className="mt-pour-inner" data-testid="pour-start">
            <PourMark markPath={markPath} small />
            <Title a={t(`${r}.titleA`)} b={t(`${r}.titleB`)} />
            <div className="mt-pb-recap" data-testid="pour-recap">
                {recap.project ? (
                    <div>
                        <i style={{ color: recap.project.colour }}>●</i>
                        <span>
                            {recap.project.name} <small>· {recap.project.path}</small>
                        </span>
                    </div>
                ) : (
                    <div>
                        <i>●</i>
                        <span>
                            {t(`${r}.noProject`)} <small>· {t(`${r}.noProjectHint`)}</small>
                        </span>
                    </div>
                )}
                {recap.view ? (
                    <>
                        <div>
                            <i className={cn(makeIconClass("table-cells-large", true), "text-12")} />
                            <span>
                                {recap.view.name} <small>· {recap.view.parts}</small>
                            </span>
                        </div>
                        <div>
                            <i className={cn(makeIconClass("thumbtack", true), "text-12")} />
                            <span>
                                {recap.place === "everywhere"
                                    ? t(`${r}.pinnedEverywhere`)
                                    : t(`${r}.pinnedHere`, { workspace: recap.workspace })}
                            </span>
                        </div>
                    </>
                ) : (
                    <div>
                        <i className={cn(makeIconClass("table-cells-large", true), "text-12")} />
                        <span>
                            {t(`${r}.noView`)} <small>· {t(`${r}.noViewHint`, { keys })}</small>
                        </span>
                    </div>
                )}
            </div>
            <p className="mt-pb-morphline">{withCodes(t(`${r}.morph`), { morph: "/morph" })}</p>
            <div className="mt-pb-next" data-testid="pour-next-views">
                <span>
                    <b>{t(`${r}.nextTitle`)}</b> {withKeys(t(`${r}.nextText`), keys)}
                </span>
                <span>{t(`${r}.nextExample`)}</span>
            </div>
        </div>
    );
}

// "{keys}" in a sentence, drawn as a key.
function withKeys(text: string, keys: string) {
    const parts = text.split("{keys}");
    return parts.map((part, i) => (
        <span key={i}>
            {part}
            {i < parts.length - 1 ? <kbd>{keys}</kbd> : null}
        </span>
    ));
}

// The recap's line for a view: its agent and its tools.
export function viewParts(agentName: string, tools: string[], t: (key: string) => string): string {
    const labels = tools.map((k) => FirstViewTools.find((x) => x.kind === k)).filter(Boolean);
    return [agentName || t("workspaceViews.panels.agent"), ...labels.map((x) => t(x.labelKey))].join(" · ");
}
