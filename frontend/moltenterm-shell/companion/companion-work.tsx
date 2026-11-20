// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's work area (FR-SHELL-018, #2392, #2416): the Tasks block first (one tab per open milestone, then the
// agent's own task list), the agents at work beside it when the companion is wide enough and under it otherwise, and a
// line from each task in progress to the agent working on it, only on a certain match. Loaded on demand, out of the
// startup bundle (companion-view.tsx).

import { ClientModel } from "@/app/store/client-model";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { useLocale, useT } from "../i18n/i18n";
import type { ReviewsAnswer } from "../reviews/reviews-model";
import { SharedReviewsAnswersAtom, SharedUpcomingAnswersAtom } from "../reviews/reviews-state-atoms";
import type { UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import { SectionBlock } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { TabActivity, whileShown } from "../tab-activity";
import { everyInPanel, panelActivityAtom, usePanelBlockId } from "../view360/offcarpet-model";
import { AgentsBlockBody } from "./companion-agents";
import { agentsRunKey, classifyTickets, HoldInputs, taskLists } from "./companion-holds-model";
import { ColumnsBand, CompanionSectionId, defaultWorkBand, workLayout } from "./companion-layout";
import {
    agentEnd,
    chosenMilestone,
    DrawnLink,
    drawnLinks,
    heatOf,
    hotEnds,
    LinkAgent,
    linkAgents,
    LinkPath,
    linkPath,
    MilestonesEvent,
    MilestonesGetCommand,
    MilestonesRoute,
    MilestonesView,
    offersSummaries,
    samePaths,
    SummariesConsentKey,
    SummariesSettingKey,
    ticketLinks,
    todoLinks,
    wantedTickets,
} from "./companion-milestone-model";
import { CompanionView } from "./companion-model";
import { useCompanionPref, useMilestoneChoice, useTakenOpen } from "./companion-prefs";
import { AgentRow, agentsView, finishedLabel } from "./companion-recap-model";
import type { SessionSectionSlots } from "./companion-section";
import { SummariesOffer, TasksBlock } from "./companion-tasks";
import "./companion-work.css";

const RpcTimeoutMs = 5000;
// While it shows, the block asks again on this beat; wavesrv reads the forge at most once a minute anyway.
const RefreshMs = 30000;
// The lane between the two columns, and the room each block keeps from its column (companion-work.css).
const ColumnGapPx = 16;
const BlockInsetPx = 32;

function cleanDir(dir: string): string {
    const trimmed = (dir ?? "").trim();
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

// The companion is on screen: its tab shows, and its panel is on the carpet.
function onScreen(panelId: string): boolean {
    const state = globalStore.get(panelId ? panelActivityAtom(panelId) : TabActivity.getInstance().stateAtom);
    return state === "active" || state === "visible";
}

// The project's open milestones, in the interface language: asked at once, on each change wavesrv announces or of the
// sentences' setting, and on a beat while the companion shows. Each ask says whether the companion is on screen: a
// hidden one only gets what was read last, and never makes wavesrv read the forge or write sentences. milestone is the
// tab shown: wavesrv reads its tickets at once when it is past the first tabs.
export function useMilestones(dir: string, want: number[], milestone: number): MilestonesView {
    const locale = useLocale();
    const panelId = usePanelBlockId();
    const summaries = useAtomValue(getSettingsKeyAtom(SummariesSettingKey));
    const [view, setView] = useState<MilestonesView>(null);
    const [rev, setRev] = useState(0);
    const project = cleanDir(dir);
    const wantKey = (want ?? []).join(",");
    useEffect(() => {
        if (!project) {
            setView(null);
            return;
        }
        let cancelled = false;
        const ask = () =>
            fireAndForget(async () => {
                try {
                    const next = await TabRpcClient.wshRpcCall(
                        MilestonesGetCommand,
                        { dir: project, lang: locale, want: want ?? [], milestone, shown: onScreen(panelId) },
                        { route: MilestonesRoute, timeout: RpcTimeoutMs }
                    );
                    if (!cancelled) {
                        setView(next as MilestonesView);
                    }
                } catch (e) {
                    console.log("companion: milestone", e);
                }
            });
        ask();
        const stop = everyInPanel(panelId, whileShown(RefreshMs), ask, "companion-milestone");
        return () => {
            cancelled = true;
            stop();
        };
    }, [project, locale, wantKey, milestone, rev, panelId, summaries]);
    useEffect(() => {
        if (!project) {
            return;
        }
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: MilestonesEvent as WaveEventName,
                scope: project,
                handler: () => setRev((r) => r + 1),
            });
        } catch (e) {
            console.log("companion: no event bus", e);
        }
        return () => unsubscribe();
    }, [project]);
    return view;
}

// The agents of the project beyond this companion's (#2418): the Integration panel's placement of every agent on its
// branch (the upcoming work) and the pull requests it follows, as the windows share them, and the agent states. Nothing
// new is polled: the placement is asked on the milestone's own beat while the companion shows, wavesrv answers it from
// its 20 s cache, and again at once, past the cache, when an agent starts or stops, as the Integration panel does.
// runKey adds this companion's own running sub-agents to what makes the placement out of date.
function useHoldsData(
    dir: string,
    runKey: string
): { upcoming: UpcomingAnswer; reviews: ReviewsAnswer; states: AgentStatesData } {
    const panelId = usePanelBlockId();
    const upcomings = useAtomValue(SharedUpcomingAnswersAtom);
    const reviews = useAtomValue(SharedReviewsAnswersAtom);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = `${agentsRunKey(states)}|${runKey}`;
    const seen = useRef<string>(null);
    const ask = (force: boolean) => {
        if (!dir || !onScreen(panelId)) {
            return;
        }
        import("../reviews/reviews-upcoming-client")
            .then((client) => client.upcomingGet(dir, force))
            .catch((e) => console.log("companion: upcoming work", e));
    };
    useEffect(() => {
        if (!dir) {
            return;
        }
        ask(seen.current != null && seen.current !== agents);
        seen.current = agents;
    }, [dir, agents]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        return everyInPanel(panelId, whileShown(RefreshMs), () => ask(false), "companion-holds");
    }, [dir, panelId]);
    return { upcoming: upcomings[dir] ?? null, reviews: reviews[dir] ?? null, states };
}

function useWidth(ref: React.RefObject<HTMLElement>): number {
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el == null) {
            return;
        }
        const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return width;
}

function linkKeyOf(target: EventTarget): string {
    const el = (target as Element)?.closest?.("[data-link-id],[data-link-end]");
    if (el == null) {
        return null;
    }
    return el.getAttribute("data-link-id") ?? el.getAttribute("data-link-end");
}

// The developer's yes to the offer: the agreement wavesrv requires first, then the setting, whose change asks again.
function turnSummariesOn() {
    const clientId = ClientModel.getInstance().clientId;
    fireAndForget(async () => {
        if (clientId != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [SummariesConsentKey]: Date.now() } as MetaType,
            });
        }
        await RpcApi.SetConfigCommand(TabRpcClient, { [SummariesSettingKey]: true } as SettingsType);
    });
}

export type CompanionWorkProps = {
    view: CompanionView;
    agentState: AgentStateInfo;
    // The project's folder, where wavesrv reads its forge.
    dir: string;
    now: number;
    // The band of the layout this area draws (companion-layout.ts), the defaults' without one, and what its other
    // sections show.
    band?: ColumnsBand;
    slots?: SessionSectionSlots;
    // A fixed width instead of the measured one (the tests, which have no layout).
    width?: number;
    // The milestones as given instead of asked, and the tab as chosen instead of the remembered one (the tests).
    milestones?: MilestonesView;
    chosen?: number;
    // What the windows know of the agents of the project, as given instead of read from the shared atoms (the tests).
    holds?: Partial<Pick<HoldInputs, "upcoming" | "reviews" | "states">>;
};

export function CompanionWork(props: CompanionWorkProps) {
    const { view, agentState, dir, now } = props;
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const measured = useWidth(rootRef);
    const rootWidth = props.width ?? measured;
    const layout = workLayout(rootWidth);
    const band = props.band ?? defaultWorkBand();
    // A band without the Tasks block (hidden or elsewhere in the layout, #2395) never asks for the milestones.
    const showsTasks = band.ids.includes("tasks");
    const project = cleanDir(dir);
    const [remembered, choose] = useMilestoneChoice(project);
    const [want, setWant] = useState<number[]>([]);
    const [shown, setShown] = useState(0);
    const asked = useMilestones(props.milestones != null || !showsTasks ? "" : dir, want, shown);
    const milestones = props.milestones ?? asked;
    const [offerAnswered, answerOffer] = useCompanionPref("summariesasked");
    const offer: SummariesOffer = offersSummaries(milestones, offerAnswered)
        ? {
              yes: () => {
                  answerOffer(true);
                  turnSummariesOn();
              },
              no: () => answerOffer(true),
          }
        : null;
    const [hot, setHot] = useState<string>(null);
    const agents = agentsView(view, agentState, now);
    const linkable = linkAgents(agents.rows, view);
    const list = milestones?.state === "ok" ? (milestones.milestones ?? []) : [];
    const m = chosenMilestone(list, props.chosen ?? remembered);
    const tickets = ticketLinks(m?.tickets, linkable);
    const known = useHoldsData(
        showsTasks && m != null ? project : "",
        [...(view?.subagents ?? [])]
            .filter((s) => s.state === "running")
            .map((s) => s.id)
            .join(",")
    );
    const holds = classifyTickets(m?.tickets, {
        mine: tickets,
        ownBlockId: view?.blockid ?? "",
        workspaceId: agentState?.workspaceid ?? "",
        upcoming: props.holds?.upcoming ?? known.upcoming,
        reviews: props.holds?.reviews ?? known.reviews,
        states: props.holds?.states ?? known.states,
    });
    const preview = m != null ? taskLists(m, tickets, holds, linkable) : null;
    const wanted = wantedTickets(preview?.rows).join(",");
    const [takenOpen, setTakenOpen] = useTakenOpen();
    useEffect(() => {
        setWant(wanted ? wanted.split(",").map(Number) : []);
    }, [wanted]);
    const shownNumber = m?.number ?? 0;
    useEffect(() => {
        setShown(shownNumber);
    }, [shownNumber]);
    const todos = view?.todos ?? [];
    // The plan's steps link to the agents only while the Tasks block is in this band (#2395): hiding it hides the lines.
    const todoAgents = showsTasks ? todoLinks(todos, linkable) : new Map<number, LinkAgent>();
    // Without the Tasks block in this band there is nothing to link an agent to.
    const links = showsTasks ? drawnLinks(preview?.rows, tickets, todoAgents) : [];
    const lit = hotEnds(links, hot);
    const ends = new Set(links.flatMap((l) => [l.from, l.to]));
    const loading = milestones?.state === "loading";
    const hasTasks = loading || m != null;
    const ended = finishedLabel(agents.finished, agents.failed);
    const agentHeat = (row: AgentRow) => (ends.has(agentEnd(row.id)) ? heatOf(row.state) : undefined);
    const shows = (id: CompanionSectionId) =>
        id === "tasks" ? hasTasks : id === "agents" || props.slots?.[id] != null;
    const left = band.left.filter(shows);
    const right = band.right.filter(shows);
    const columns = layout === "columns" && left.length > 0 && right.length > 0;
    // A line needs the tasks and the agents in the two columns; anywhere else, the chips say who works on what.
    const sideOf = (id: CompanionSectionId) => (left.includes(id) ? "left" : right.includes(id) ? "right" : null);
    const sideBySide =
        columns &&
        hasTasks &&
        sideOf("tasks") != null &&
        sideOf("agents") != null &&
        sideOf("tasks") !== sideOf("agents");
    const chips = !sideBySide;
    // The Tasks block's own width, from its column's: it decides how many tabs fit and which forms the header takes.
    const blockWidth = Math.max(0, Math.floor(columns ? (rootWidth - ColumnGapPx) / 2 : rootWidth) - BlockInsetPx);
    const sections: Partial<Record<CompanionSectionId, React.ReactNode>> = {
        ...props.slots,
        tasks: hasTasks ? (
            <TasksBlock
                loading={loading}
                milestones={list}
                selected={m}
                onSelect={choose}
                width={rootWidth > 0 ? blockWidth : 0}
                lists={preview}
                takenOpen={takenOpen}
                onTakenChange={setTakenOpen}
                phrasing={milestones?.phrasing === true}
                offer={offer}
                links={tickets}
                now={now}
                chips={chips}
                lit={lit}
                ends={ends}
            />
        ) : null,
        agents: (
            <SectionBlock
                title={t("companion.agents.title")}
                icon={suiteIcon("agent")}
                className="mt-cwork-block"
                data-testid="companion-agents"
            >
                <AgentsBlockBody
                    rows={agents.rows}
                    view={view}
                    marks={{ ends, hot: lit, heat: agentHeat, chips, todoLinks: todoAgents }}
                    ended={ended}
                    now={now}
                />
            </SectionBlock>
        ),
    };
    const place = (ids: CompanionSectionId[]) => ids.map((id) => <Fragment key={id}>{sections[id]}</Fragment>);
    // A band whose sections all have nothing to show takes no room; the root stays mounted so its width is measured.
    const empty = !band.ids.some(shows);
    return (
        <div
            ref={rootRef}
            className="mt-cwork"
            data-layout={layout}
            data-both={columns ? "" : undefined}
            data-empty={empty ? "" : undefined}
            data-testid="companion-work"
            onPointerOver={(e) => {
                const key = linkKeyOf(e.target);
                if (key !== hot) {
                    setHot(key);
                }
            }}
            onPointerLeave={() => setHot(null)}
        >
            {columns ? (
                <>
                    <div className="mt-cwork-col" data-column="left">
                        {place(left)}
                    </div>
                    <div className="mt-cwork-col" data-column="right">
                        {place(right)}
                    </div>
                </>
            ) : (
                place(band.ids.filter(shows))
            )}
            {sideBySide && links.length > 0 ? <LinkLayer rootRef={rootRef} links={links} lit={lit} /> : null}
        </div>
    );
}

function scrollParent(el: HTMLElement): HTMLElement {
    for (let p = el.parentElement; p != null; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if (overflow === "auto" || overflow === "scroll") {
            return p;
        }
    }
    return null;
}

// The lines, drawn over the two columns: each follows its two ends as the layout resizes or scrolls.
function LinkLayer({
    rootRef,
    links,
    lit,
}: {
    rootRef: React.RefObject<HTMLDivElement>;
    links: DrawnLink[];
    lit: Set<string>;
}) {
    const [paths, setPaths] = useState<LinkPath[]>([]);
    const schedule = useRef<() => void>(null);
    const key = links.map((l) => `${l.id}:${l.heat}`).join("|");
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (root == null) {
            return;
        }
        let frame = 0;
        const measure = () => {
            frame = 0;
            const origin = root.getBoundingClientRect();
            const boxes = new Map<string, DOMRect>();
            root.querySelectorAll<HTMLElement>("[data-link-end]").forEach((el) =>
                boxes.set(el.getAttribute("data-link-end"), el.getBoundingClientRect())
            );
            const next = links
                .map((l) => linkPath(l, boxes.get(l.from), boxes.get(l.to), origin))
                .filter((p) => p != null);
            setPaths((prev) => (samePaths(prev, next) ? prev : next));
        };
        const later = () => {
            if (frame === 0) {
                frame = requestAnimationFrame(measure);
            }
        };
        schedule.current = later;
        measure();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
        observer?.observe(root);
        root.querySelectorAll("[data-link-end]").forEach((el) => observer?.observe(el));
        const scroller = scrollParent(root);
        scroller?.addEventListener("scroll", later, { passive: true });
        root.addEventListener("scroll", later, { capture: true, passive: true });
        window.addEventListener("resize", later);
        return () => {
            schedule.current = null;
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }
            observer?.disconnect();
            scroller?.removeEventListener("scroll", later);
            root.removeEventListener("scroll", later, { capture: true });
            window.removeEventListener("resize", later);
        };
    }, [key]);
    // A row that moves without changing size (a sentence arrived above it) is measured again after each render.
    useLayoutEffect(() => {
        schedule.current?.();
    });
    return (
        <svg className="mt-cwork-links" aria-hidden="true" data-testid="companion-work-links">
            {paths.map((p) => (
                <g
                    key={p.id}
                    data-heat={p.heat}
                    data-link-hot={lit.has(p.id) ? "" : undefined}
                    data-testid="companion-work-link"
                >
                    <path className="mt-cwork-link" d={p.d} />
                    <path className="mt-cwork-flow" d={p.d} pathLength={100} />
                    <circle className="mt-cwork-dot" cx={p.x1} cy={p.y1} r={2.5} />
                    <circle className="mt-cwork-dot" cx={p.x2} cy={p.y2} r={2.5} />
                    <path className="mt-cwork-hit" d={p.d} data-link-id={p.id} />
                </g>
            ))}
        </svg>
    );
}
