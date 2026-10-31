// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The five scenes of the pour (FR-ONB-007): each takes what it shows as props, so the scenes render without a window
// in tests. onboarding-pour.tsx holds the stage, the navigation and the sparks.

import { modalsModel } from "@/app/store/modalmodel";
import { MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { formatKeys, modifierLabel } from "../moltenterm-shell/shortcuts/format";
import { ShortcutsSheetKey } from "../moltenterm-shell/shortcuts/registry";
import { GlowRing } from "../moltenterm-shell/suite/suite";
import { TabActivity, whileShown } from "../moltenterm-shell/tab-activity";
import { CopyLine, ExternalLink, withCodes } from "./onboarding-parts";
import { CodexHooksCommand, DeepSeekRecipe, PourAgentCard } from "./onboarding-pour-agents";
import {
    MaterialsDelayMs,
    PourStart,
    PourStarts,
    SlideMs,
    SlideReducedMs,
    TypeMs,
    TypePauseMs,
    WriteMs,
} from "./onboarding-pour-model";
import { WorkspaceColours } from "./onboarding-project-model";

export const MoltentermLicenseUrl = `${MoltentermRepoUrl}/blob/main/LICENSE`;
export const MoltentermPrivacyUrl = `${MoltentermRepoUrl}/blob/main/PRIVACY.md`;

// The mark's path padded so its stroke and glow are not clipped (the identity's own viewBox is 0 0 298 235).
const MarkViewBox = "-6 -6 310 247";
// The molten surface: a wavy top, poured up from below the mould by .mt-pour-melt.
const MeltPath = "M-10 6 Q40 -6 90 6 T190 6 T310 6 V260 H-10 Z";

function Title({ a, b }: { a: string; b: string }) {
    return (
        <h1>
            {a}
            <br />
            <span className="mt-pour-hot">{b}</span>
        </h1>
    );
}

// The real MoltenTerm mark (one fused path, moltenterm-identity.ts) in its mould: it fills like molten metal, then
// sets; the small mould of the last scene shows it set.
export function PourMark({ markPath, small }: { markPath: string; small?: boolean }) {
    const id = useId().replace(/[^\w-]/g, "");
    const gradient = `mt-pour-g-${id}`;
    const clip = `mt-pour-c-${id}`;
    return (
        <div className="mt-pour-mould" data-small={small ? "" : undefined} aria-hidden>
            {small ? null : <span className="mt-pour-drop" />}
            <GlowRing on />
            <svg viewBox={MarkViewBox}>
                <defs>
                    <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="235">
                        <stop offset="0" stopColor="var(--pour-white)" />
                        <stop offset=".3" stopColor="var(--pour-hot)" />
                        <stop offset="1" stopColor="var(--pour-molten)" />
                    </linearGradient>
                    <clipPath id={clip}>
                        <path d={markPath} />
                    </clipPath>
                </defs>
                {small ? null : <path className="mt-pour-cavity" d={markPath} />}
                <g className="mt-pour-glow">
                    {small ? null : (
                        <g clipPath={`url(#${clip})`}>
                            <g className="mt-pour-melt">
                                <path d={MeltPath} fill={`url(#${gradient})`} />
                            </g>
                        </g>
                    )}
                    <path className="mt-pour-set" d={markPath} />
                </g>
            </svg>
        </div>
    );
}

// Scene 1, the pour (AC-3): the mark fills, then the title and what MoltenTerm is; the licence and the privacy
// commitment stay one click away (NFR-ONB-002).
export function PourScene({ markPath, names }: { markPath: string; names: [string, string] }) {
    const t = useT();
    return (
        <div className="mt-pour-inner">
            <PourMark markPath={markPath} />
            <div className="mt-pour-kicker mt-pour-rise" data-d="1">
                {t("onboarding.pour.pour.kicker")}
            </div>
            <div className="mt-pour-rise" data-d="2">
                <Title a={t("onboarding.pour.pour.titleA")} b={t("onboarding.pour.pour.titleB")} />
            </div>
            <p className="mt-pour-sub mt-pour-rise" data-d="3">
                {t("onboarding.pour.pour.sub", { first: names[0], second: names[1] })}
            </p>
            <p className="mt-pour-legal mt-pour-rise flex flex-wrap justify-center gap-x-3 gap-y-1" data-d="3">
                <span>{t("onboarding.pour.legal.license")}</span>
                <a href={MoltentermLicenseUrl} target="_blank" rel="noopener" className="cursor-pointer">
                    {t("onboarding.pour.legal.licence")}
                </a>
                <a href={MoltentermPrivacyUrl} target="_blank" rel="noopener" className="cursor-pointer">
                    {t("onboarding.pour.legal.privacy")}
                </a>
                <button
                    type="button"
                    onClick={() => modalsModel.pushModal("AboutModal")}
                    className="cursor-pointer"
                    data-testid="first-run-about"
                >
                    {t("onboarding.pour.legal.about")}
                </button>
            </p>
        </div>
    );
}

function AgentCardView({
    card,
    heating,
    open,
    onToggle,
}: {
    card: PourAgentCard;
    heating: boolean;
    open: boolean;
    onToggle: () => void;
}) {
    const t = useT();
    const status = card.recipe
        ? t("onboarding.pour.agents.status.recipe", { agent: card.agentName })
        : heating
          ? t("onboarding.pour.agents.status.looking")
          : card.ready
            ? t("onboarding.pour.agents.status.ready")
            : t("onboarding.pour.agents.status.missing");
    return (
        <div
            className="mt-pour-agent"
            data-agent={card.id}
            data-ready={card.ready ? "" : undefined}
            data-heating={heating ? "" : undefined}
            data-open={open ? "" : undefined}
        >
            <div className="mt-pour-ingot" />
            <div className="text-15 font-semibold">{card.name}</div>
            <div className="-mt-1.5 font-mono text-11 text-secondary">
                {card.recipe
                    ? t("onboarding.pour.agents.recipeCommand", { command: card.command })
                    : `$ ${card.command}`}
            </div>
            <div className="flex flex-col gap-0.5 text-11 text-secondary">
                <span>{t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider })}</span>
                {card.recipe ? null : (
                    <span className={card.full ? "font-medium text-[var(--pour-hot)]" : "text-muted"}>
                        {t(card.full ? "onboarding.pour.agents.level.full" : "onboarding.pour.agents.level.process")}
                    </span>
                )}
                {card.hooksNote && card.ready ? (
                    <span className="text-muted" data-testid="pour-codex-hooks">
                        {withCodes(t("onboarding.pour.agents.hooks"), { command: CodexHooksCommand })}
                    </span>
                ) : null}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2">
                <div className="mt-pour-status flex items-center gap-1.5 text-12 text-muted">
                    <span className="mt-pour-status-dot" />
                    {status}
                </div>
                {card.ready && !card.recipe ? null : (
                    <button
                        type="button"
                        className="mt-pour-act cursor-pointer"
                        aria-expanded={open}
                        onClick={onToggle}
                        data-testid={`pour-act-${card.id}`}
                    >
                        {t(card.recipe ? "onboarding.pour.agents.configure" : "onboarding.pour.agents.install")}
                    </button>
                )}
            </div>
        </div>
    );
}

// What Install or Configure opens: the official command to copy and the account it needs, or the DeepSeek recipe.
// Nothing runs from here (installing in a terminal beside the pour is 1.1.0).
function AgentDrawer({
    card,
    claudeReady,
    checking,
    onCheck,
}: {
    card: PourAgentCard;
    claudeReady: boolean;
    checking: boolean;
    onCheck: () => void;
}) {
    const t = useT();
    const account = t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider });
    return (
        <div className="mt-pour-drawer" data-testid={`pour-drawer-${card.id}`}>
            <div className="text-13 font-semibold">
                {card.recipe
                    ? t("onboarding.pour.agents.recipeTitle", { model: card.name, agent: card.agentName })
                    : t("onboarding.pour.agents.installTitle", { name: card.name })}
            </div>
            <p className="text-12 leading-5 text-secondary">
                {card.recipe
                    ? t("onboarding.pour.agents.recipeText", { model: card.name })
                    : t("onboarding.pour.agents.installText")}
            </p>
            <div className="flex flex-col gap-1.5">
                {(card.recipe ? [DeepSeekRecipe.join("\n")] : card.install.slice(0, 1)).map((line) => (
                    <CopyLine key={line} text={line} testId={`pour-command-${card.id}`} />
                ))}
                {card.install.slice(1).map((line) => (
                    <div key={line} className="flex flex-col gap-1">
                        <span className="text-11 text-muted">{t("onboarding.pour.agents.or")}</span>
                        <CopyLine text={line} />
                    </div>
                ))}
            </div>
            <p className="text-12 text-secondary">{t("onboarding.pour.agents.needs", { account })}</p>
            {card.recipe && !claudeReady ? (
                <p className="text-12 text-secondary">
                    {t("onboarding.pour.agents.recipeNeedsAgent", { agent: card.agentName })}
                </p>
            ) : null}
            {card.hooksNote ? (
                <p className="text-12 text-secondary">
                    {withCodes(t("onboarding.pour.agents.hooks"), { command: CodexHooksCommand })}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                {card.recipe ? null : (
                    <button
                        type="button"
                        disabled={checking}
                        onClick={onCheck}
                        className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        data-testid="pour-check-again"
                    >
                        {checking ? t("onboarding.pour.agents.status.looking") : t("onboarding.pour.agents.checkAgain")}
                    </button>
                )}
                {card.installPage ? (
                    <ExternalLink href={card.installPage}>
                        {t(card.recipe ? "onboarding.pour.agents.recipePage" : "onboarding.pour.agents.installPage")}
                    </ExternalLink>
                ) : null}
            </div>
        </div>
    );
}

// Scene 2, your agents heat up (AC-4, AC-5): the real detection, as cards.
export function AgentsScene({
    cards,
    loading,
    error,
    checking,
    open,
    ready,
    onToggle,
    onCheck,
}: {
    cards: PourAgentCard[];
    loading: boolean;
    error?: string;
    checking: boolean;
    open: string;
    // the agent that became ready at the last check, for "{name} is ready"
    ready?: string;
    onToggle: (id: string) => void;
    onCheck: () => void;
}) {
    const t = useT();
    const found = cards.filter((c) => c.ready).length;
    const openCard = cards.find((c) => c.id === open);
    const claudeReady = cards.some((c) => c.id === "claude-code" && c.ready);
    let sub: string;
    if (error) {
        sub = error;
    } else if (loading) {
        sub = t("onboarding.pour.agents.looking");
    } else if (ready) {
        sub = t("onboarding.pour.agents.nowReady", { name: ready });
    } else {
        sub =
            found === 0
                ? t("onboarding.pour.agents.found.none")
                : found === 1
                  ? t("onboarding.pour.agents.found.one")
                  : t("onboarding.pour.agents.found.other", { count: found });
    }
    return (
        <div className="mt-pour-inner" data-testid="pour-agents">
            <div className="mt-pour-kicker">{t("onboarding.pour.agents.kicker")}</div>
            <Title a={t("onboarding.pour.agents.titleA")} b={t("onboarding.pour.agents.titleB")} />
            <p className="mt-pour-sub" role="status">
                {sub}
            </p>
            <div className="mt-pour-forge">
                {cards.map((card) => (
                    <AgentCardView
                        key={card.id}
                        card={card}
                        heating={checking && !card.ready && !card.recipe}
                        open={card.id === open}
                        onToggle={() => onToggle(card.id)}
                    />
                ))}
            </div>
            {openCard ? (
                <AgentDrawer card={openCard} claudeReady={claudeReady} checking={checking} onCheck={onCheck} />
            ) : null}
        </div>
    );
}

// The workshop's sample data (AC-6): three workspaces of the real palette, names and contents as keys of
// onboarding.pour.workshop.*. Nothing here is the user's.
type SampleTile = { key: string; icon: string; on?: boolean; forged?: boolean };
type SampleSpace = { key: string; colour: string; tiles: SampleTile[]; temps: string[] };

const Spaces: SampleSpace[] = [
    {
        key: "atlas",
        colour: WorkspaceColours[2],
        tiles: [
            { key: "scoping", icon: "table-cells-large", on: true },
            { key: "integration", icon: "right-left" },
            { key: "browser", icon: "globe" },
            { key: "clock", icon: "clock", forged: true },
        ],
        temps: ["localhost:5173", "README.md"],
    },
    {
        key: "billing",
        colour: WorkspaceColours[5],
        tiles: [
            { key: "scoping", icon: "table-cells-large" },
            { key: "integration", icon: "right-left", on: true },
            { key: "logs", icon: "bars" },
            { key: "quotas", icon: "database", forged: true },
        ],
        temps: ["openapi.yaml"],
    },
    {
        key: "book",
        colour: WorkspaceColours[3],
        tiles: [
            { key: "manuscript", icon: "paragraph", on: true },
            { key: "outline", icon: "list" },
            { key: "cover", icon: "image" },
            { key: "words", icon: "hashtag", forged: true },
        ],
        temps: ["@chapter"],
    },
];

const MaterialsBefore = 7;

function SpaceSidebar({ space }: { space: SampleSpace }) {
    const t = useT();
    const k = `onboarding.pour.workshop.spaces.${space.key}`;
    return (
        <div>
            <div className="mt-pour-wsh">
                <i style={{ background: space.colour }} />
                {t(`${k}.name`)}
                <small>{t(`${k}.tag`)}</small>
            </div>
            <div className="mt-pour-tiles">
                {space.tiles.map((tile) => (
                    <span
                        key={tile.key}
                        className="mt-pour-tile"
                        data-on={tile.on ? "" : undefined}
                        data-forged={tile.forged ? "" : undefined}
                    >
                        <i className={`fa-solid fa-${tile.icon}`} />
                        {t(`onboarding.pour.workshop.tiles.${tile.key}`)}
                    </span>
                ))}
            </div>
            {space.temps.map((temp) => (
                <div key={temp} className="mt-pour-temp">
                    ◌ {temp === "@chapter" ? t(`${k}.temp`) : temp}
                </div>
            ))}
            <div className="mt-pour-bline">{t(`${k}.branch`)}</div>
        </div>
    );
}

function Dot({ colour }: { colour: string }) {
    return <i style={{ background: colour }} />;
}

function SpaceViews({ tool }: { tool: string }) {
    const t = useT();
    const w = "onboarding.pour.workshop";
    return (
        <>
            <div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.agent`)}</span>
                    <div className="mt-pour-tl" data-lines="">
                        <div>
                            <span className="mt-pour-p">❯</span> claude
                        </div>
                        <div>
                            <span className="mt-pour-n">Diane</span> · {t(`${w}.atlas.l1`)}
                        </div>
                        <div>
                            <span className="mt-pour-n">Diane</span> → <span className="mt-pour-n">Jérôme</span>{" "}
                            {t(`${w}.atlas.l2`, { tool })}
                        </div>
                        <div>
                            <span className="mt-pour-g">✓</span> {t(`${w}.atlas.l3`)}
                        </div>
                    </div>
                </div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.atlas.view`)}</span>
                    <div className="mt-pour-page" />
                    <div className="mt-pour-card">
                        <Dot colour="var(--pour-ready)" />
                        {t(`${w}.atlas.ticket`)}
                    </div>
                    <div className="mt-pour-card" data-forged="">
                        <Dot colour="var(--pour-molten)" />
                        {t(`${w}.atlas.clock`)}
                    </div>
                </div>
            </div>
            <div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.agent`)}</span>
                    <div className="mt-pour-tl">
                        <div>
                            <span className="mt-pour-p">❯</span> codex
                        </div>
                        <div>
                            <span className="mt-pour-n">Jérôme</span> · {t(`${w}.billing.l1`)}
                        </div>
                        <div className="text-muted">{t(`${w}.billing.l2`)}</div>
                    </div>
                </div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.billing.view`)}</span>
                    <div className="mt-pour-card">
                        <Dot colour="var(--pour-hot)" />
                        {t(`${w}.billing.ci`)}
                    </div>
                    <div className="mt-pour-card">
                        <Dot colour="var(--pour-ready)" />
                        {t(`${w}.billing.pr`)}
                    </div>
                    <div className="mt-pour-card">
                        <Dot colour="var(--mt-text-3)" />
                        {t(`${w}.billing.logs`)}
                    </div>
                    <div className="mt-pour-card" data-forged="">
                        <Dot colour="var(--pour-molten)" />
                        {t(`${w}.billing.quotas`)}
                    </div>
                </div>
            </div>
            <div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.agent`)}</span>
                    <div className="mt-pour-tl">
                        <div>
                            <span className="mt-pour-p">❯</span> claude
                        </div>
                        <div>
                            <span className="mt-pour-n">Diane</span> · {t(`${w}.book.l1`)}
                        </div>
                        <div>
                            <span className="mt-pour-g">✓</span> {t(`${w}.book.l2`)}
                        </div>
                    </div>
                </div>
                <div className="mt-pour-col">
                    <span className="mt-pour-lbl">{t(`${w}.book.view`)}</span>
                    <div className="mt-pour-md">
                        <h4>{t(`${w}.book.chapter`)}</h4>
                        {t(`${w}.book.text`)}
                    </div>
                    <div className="mt-pour-mock">{t(`${w}.book.mock`)}</div>
                </div>
            </div>
        </>
    );
}

// The workshop window (AC-6): the spaces slide on their own; the dots or a horizontal swipe take over. An
// illustration only: hidden from assistive technology, the text alternative says the same.
function WorkshopWindow({ reduced, tool }: { reduced: boolean; tool: string }) {
    const t = useT();
    const [space, setSpace] = useState(0);
    const [auto, setAuto] = useState(true);
    const [step, setStep] = useState(0);
    const [materials, setMaterials] = useState(MaterialsBefore);
    const [matsShown, setMatsShown] = useState(false);
    const win = useRef<HTMLDivElement>(null);
    const w = "onboarding.pour.workshop";

    // Atlas, Billing (the shared row lights up: it stayed put), The Book (its mock-up joins the Materials), Atlas.
    useEffect(() => {
        if (!auto) {
            return;
        }
        return TabActivity.getInstance().every(
            whileShown(reduced ? SlideReducedMs : SlideMs),
            () => setStep((s) => s + 1),
            "pour-workshop"
        );
    }, [auto, reduced]);

    useEffect(() => {
        if (step > 0) {
            setSpace(step % Spaces.length);
        }
    }, [step]);

    useEffect(() => {
        setMatsShown(false);
        if (space !== 2) {
            return;
        }
        const timer = setTimeout(
            () => {
                setMaterials(MaterialsBefore + 1);
                setMatsShown(true);
            },
            reduced ? 0 : MaterialsDelayMs
        );
        return () => clearTimeout(timer);
    }, [space, reduced]);

    useEffect(() => {
        const el = win.current;
        if (el == null) {
            return;
        }
        const onWheel = (e: WheelEvent) => {
            if (Math.abs(e.deltaX) < 30 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                return;
            }
            e.preventDefault();
            setAuto(false);
            setSpace((s) => (s + (e.deltaX > 0 ? 1 : -1) + Spaces.length) % Spaces.length);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);

    const shift = { transform: `translateX(-${space * 100}%)` };
    return (
        <div
            ref={win}
            className="mt-pour-win"
            style={{ "--ws": Spaces[space].colour } as React.CSSProperties}
            aria-hidden
            data-space={space}
        >
            <div className="mt-pour-sb">
                <div className="mt-pour-wrow">
                    <i className="fa-solid fa-mug-hot" />
                    <i className="fa-solid fa-bell" />
                    <i className="fa-solid fa-table-columns" />
                </div>
                <div className="mt-pour-field">
                    <i className="fa-solid fa-magnifying-glass" />
                    {t(`${w}.search`)}
                </div>
                <div
                    className="mt-pour-toprow"
                    key={`row-${step % 3 === 1 ? step : 0}`}
                    data-flash={step % 3 === 1 ? "" : undefined}
                >
                    <span>
                        <i className="fa-solid fa-envelope" />
                    </span>
                    <span>
                        <i className="fa-solid fa-clock" />
                    </span>
                    <span>
                        <i className="fa-solid fa-code-branch" />
                    </span>
                    <span>
                        <i className="fa-solid fa-check" />
                    </span>
                </div>
                <div className="mt-pour-slider">
                    <div className="mt-pour-track" style={shift}>
                        {Spaces.map((s) => (
                            <SpaceSidebar key={s.key} space={s} />
                        ))}
                    </div>
                </div>
                <div className="mt-pour-bbar">
                    <span className="mt-pour-lib" key={`lib-${materials}`} data-pulse={matsShown ? "" : undefined}>
                        <i className="fa-solid fa-box-archive" /> <b>{materials}</b>
                    </span>
                    <div className="mt-pour-dots">
                        {Spaces.map((s, i) => (
                            <button
                                key={s.key}
                                type="button"
                                tabIndex={-1}
                                className="cursor-pointer"
                                style={{ "--c": s.colour } as React.CSSProperties}
                                data-on={i === space ? "" : undefined}
                                onClick={() => {
                                    setAuto(false);
                                    setSpace(i);
                                }}
                            />
                        ))}
                    </div>
                    <span className="text-13 text-muted">+</span>
                </div>
                <div className="mt-pour-mats" data-show={matsShown ? "" : undefined}>
                    <span className="mt-pour-lbl mb-1">{t(`${w}.materials.title`)}</span>
                    <div>
                        <Dot colour={Spaces[2].colour} />
                        {t(`${w}.materials.cover`)}
                    </div>
                    <div>
                        <Dot colour={Spaces[0].colour} />
                        {t(`${w}.materials.capture`)}
                    </div>
                    <div>
                        <Dot colour={Spaces[1].colour} />
                        {t(`${w}.materials.load`)}
                    </div>
                    <div>
                        <Dot colour={Spaces[0].colour} />
                        {t(`${w}.materials.demo`)}
                    </div>
                </div>
            </div>
            <div className="mt-pour-wview">
                <div className="mt-pour-track" style={shift}>
                    <SpaceViews tool={tool} />
                </div>
            </div>
        </div>
    );
}

const Ideas = ["spaces", "fitted", "custom", "kept"];

// Scene 3, a workbench per project (AC-6).
export function WorkshopScene({ reduced, tool }: { reduced: boolean; tool: string }) {
    const t = useT();
    const w = "onboarding.pour.workshop";
    return (
        <div className="mt-pour-inner" data-testid="pour-workshop">
            <div className="mt-pour-kicker">{t(`${w}.kicker`)}</div>
            <Title a={t(`${w}.titleA`)} b={t(`${w}.titleB`)} />
            <p className="sr-only">{t(`${w}.alt`)}</p>
            <WorkshopWindow reduced={reduced} tool={tool} />
            <div className="-mt-2.5 text-12 text-muted">{t(`${w}.swipe`)}</div>
            <div className="mt-pour-four">
                {Ideas.map((idea) => (
                    <div key={idea}>
                        <b className="mb-0.5 block text-13">{t(`${w}.ideas.${idea}.title`)}</b>
                        <span className="text-12 leading-[1.45] text-secondary">
                            {withCodes(t(`${w}.ideas.${idea}.text`), { morph: "/morph" })}
                        </span>
                    </div>
                ))}
            </div>
            <p className="mt-pour-coda">
                {t(`${w}.coda`)} <b>{t(`${w}.codaHot`)}</b>
            </p>
        </div>
    );
}

// Scene 4, /morph (AC-7): a request is typed, the agent writes the mod, a panel pours in and cools. A demo: nothing
// runs.
export function MorphScene({ reduced, onPoured }: { reduced: boolean; onPoured?: (el: Element) => void }) {
    const t = useT();
    const request = t("onboarding.pour.morph.request");
    const [typed, setTyped] = useState(reduced ? request : "");
    const [phase, setPhase] = useState<"typing" | "writing" | "poured">(reduced ? "poured" : "typing");
    const [run, setRun] = useState(0);
    const cast = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (reduced) {
            setTyped(request);
            setPhase("poured");
            return;
        }
        setTyped("");
        setPhase("typing");
        // One short-lived timer at a time: a character, then the pause, then the agent writing.
        let i = 0;
        let timer: ReturnType<typeof setTimeout> = null;
        const type = () => {
            i++;
            setTyped(request.slice(0, i));
            if (i < request.length) {
                timer = setTimeout(type, TypeMs);
                return;
            }
            timer = setTimeout(() => {
                setPhase("writing");
                timer = setTimeout(() => setPhase("poured"), WriteMs);
            }, TypePauseMs);
        };
        timer = setTimeout(type, TypeMs);
        return () => clearTimeout(timer);
    }, [run, reduced, request]);

    useEffect(() => {
        if (phase === "poured" && !reduced && cast.current != null) {
            onPoured?.(cast.current);
        }
    }, [phase, run]);

    return (
        <div className="mt-pour-inner" data-testid="pour-morph">
            <div className="mt-pour-kicker">{t("onboarding.pour.morph.kicker")}</div>
            <Title a={t("onboarding.pour.morph.titleA")} b={t("onboarding.pour.morph.titleB")} />
            <div className="mt-pour-morph">
                <div className="mt-pour-tl" aria-live="polite">
                    <div>
                        <span className="mt-pour-p">❯</span>{" "}
                        <span className={phase === "typing" ? "mt-pour-typing" : undefined}>{typed}</span>
                    </div>
                    {phase !== "typing" ? <div className="text-muted">{t("onboarding.pour.morph.writing")}</div> : null}
                    {phase === "poured" ? (
                        <div>
                            <span className="mt-pour-g">✓</span> {t("onboarding.pour.morph.checked")}
                        </div>
                    ) : null}
                </div>
                <div
                    ref={cast}
                    key={`cast-${run}`}
                    className="mt-pour-cast"
                    data-poured={phase === "poured" ? "" : undefined}
                    aria-hidden
                >
                    <div className="mt-pour-clock">
                        10:24<small>{t("onboarding.pour.morph.clockSub")}</small>
                    </div>
                </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                    type="button"
                    className="mt-pour-calm cursor-pointer px-[18px] py-[11px] text-15"
                    onClick={() => setRun((r) => r + 1)}
                    data-testid="pour-replay"
                >
                    {t("onboarding.pour.morph.replay")}
                </button>
                <span className="text-12 text-muted">
                    {withCodes(t("onboarding.pour.morph.undo"), { command: "molten undo" })}
                </span>
            </div>
        </div>
    );
}

// The shortcut overlay (FR-SHELL-090), in the platform's keys, as the welcome said it.
function ShortcutsHint() {
    const t = useT();
    const parts = t("onboarding.pour.start.shortcuts").split(/\{(hold|press)\}/);
    const keys: Record<string, string> = { hold: modifierLabel("Cmd"), press: formatKeys(ShortcutsSheetKey) };
    return (
        <p className="text-12 text-muted">
            {parts.map((part, i) =>
                i % 2 === 1 ? (
                    <kbd key={i} className="rounded-4 border border-border px-1 font-mono text-11 text-secondary">
                        {keys[part]}
                    </kbd>
                ) : (
                    part
                )
            )}
        </p>
    );
}

// Scene 5, the forge is hot (AC-8): three starts, one chosen at a time; the main button runs it.
export function StartScene({
    markPath,
    start,
    morphAgentName,
    morphRequest,
    onChoose,
}: {
    markPath: string;
    start: PourStart;
    // the agent Try /morph opens, and the first request to paste into it; none without an agent
    morphAgentName?: string;
    morphRequest?: string;
    onChoose: (start: PourStart) => void;
}) {
    const t = useT();
    return (
        <div className="mt-pour-inner" data-testid="pour-start">
            <PourMark markPath={markPath} small />
            <Title a={t("onboarding.pour.start.titleA")} b={t("onboarding.pour.start.titleB")} />
            <p className="mt-pour-sub">{t("onboarding.pour.start.sub")}</p>
            <div className="mt-pour-pick">
                {PourStarts.map((id) => (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={start === id}
                        onClick={() => onChoose(id)}
                        className="cursor-pointer"
                        data-start={id}
                    >
                        <b className="text-13">{t(`onboarding.pour.start.${id}.title`, { morph: "/morph" })}</b>
                        <span className="text-12 text-secondary">{t(`onboarding.pour.start.${id}.text`)}</span>
                    </button>
                ))}
            </div>
            {start === "morph" ? (
                morphAgentName ? (
                    <div className="flex w-[min(560px,100%)] flex-col gap-1.5 text-left" data-testid="pour-morph-hint">
                        <p className="text-12 text-secondary">
                            {t("onboarding.pour.start.morphHint", { name: morphAgentName })}
                        </p>
                        <CopyLine text={morphRequest} />
                    </div>
                ) : (
                    <p className="text-12 text-secondary" data-testid="pour-morph-noagent">
                        {t("onboarding.pour.start.morphNoAgent")}
                    </p>
                )
            ) : null}
            <ShortcutsHint />
        </div>
    );
}
