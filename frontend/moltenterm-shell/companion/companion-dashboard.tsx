// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion as the main agent's dashboard (FR-SHELL-018, #2441): the hero (the agent, its session and its plan),
// then every section as the same block in a flow of one to three columns (companion-flow-model.ts), the milestone and
// the agents at work side by side as a linked pair, and the arranging mode in place. Arranging keeps the dashboard as it
// is (#2467): the same blocks, in the same flow, with their real content held still under the controls the mode lays over
// them (companion-arrange-chrome.tsx), and a ghost where a block has nothing to show or is hidden (companion-ghost.tsx).
// Loaded on demand, out of the startup bundle (companion-view.tsx).

import { Markdown } from "@/app/element/markdown";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentStateInfo } from "../agent-state-model";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { DominoLoader } from "../suite/suite";
import { getHomeDir } from "../tab-identity-ui";
import { mainName } from "./companion-agents";
import { ArrangeBar, ArrangeNote, useArrangeChrome } from "./companion-arrange-chrome";
import { ArrangeContext } from "./companion-arrange-context";
import { flowEntries, resetLayout, SectionNameKeys } from "./companion-arrange-model";
import { useArrangeSession } from "./companion-arrange-session";
import { usePermitControl } from "./companion-autonomy";
import { BlockTool, CompanionBlock, CopyTool, CountChip, FootLink } from "./companion-block";
import { BlockCapContext, makeBlockCapValue } from "./companion-block-cap";
import { Pickup, SectionIdSet, useBlockDrag, ZoneState } from "./companion-block-drag";
import "./companion-dashboard.css";
import { startLongPress, startsPress } from "./companion-drag-model";
import { FilesSection } from "./companion-files";
import { FlowAssign, flowLayout, FlowPlacedEvent, keepsColumns, layoutIdOf } from "./companion-flow-model";
import { FlowBlockSelector, FlowWatch, watchFlow } from "./companion-flow-watch";
import {
    PlanUsageBody,
    PlanUsageSection,
    ProviderUsageNote,
    UsageForm,
    UsageFrame,
    UsageFrameParts,
} from "./companion-gauges";
import type { GaugesView } from "./companion-gauges-model";
import { ArrangeGhost } from "./companion-ghost";
import { CompanionHero } from "./companion-hero";
import { CompanionLayout, CompanionSectionId, usageOf } from "./companion-layout";
import { MilestonesView } from "./companion-milestone-model";
import {
    CompanionAnswer,
    CompanionAnswerCommand,
    companionMarkdown,
    CompanionRoute,
    CompanionView,
    neighbourAnswer,
    usageAction,
} from "./companion-model";
import { PermissionBlock } from "./companion-permit-block";
import { RecentTopicsSection } from "./companion-recap";
import { mainAgentRow } from "./companion-recap-model";
import { SectionTiles } from "./companion-section-tiles";
import { TaskFrameFn, WorkspaceTaskCard, WorkspaceTaskSection } from "./companion-task";
import { taskSessionLabel, TaskView } from "./companion-task-model";
import { openUsagePage, UsageButton } from "./companion-usage";
import { UsageRowsProps, usageRowsProps, withRowChoice } from "./companion-usage-rows-model";
import { CompanionWork, CompanionWorkProps } from "./companion-work";

const RpcTimeoutMs = 5000;

function companionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

export type CompanionDashboardProps = {
    view: CompanionView;
    target: string;
    // The companion's own block, where the files and the task open their previews.
    companionId: string;
    agentState: AgentStateInfo;
    // The session runs behind another provider (FR-AGC-008): its usage is not the agent's.
    provider: string;
    // The project's folder, where the milestone is read, and the terminal's folder, from which paths are relative.
    dir: string;
    folder: string;
    layout: CompanionLayout;
    onSaveLayout: (layout: CompanionLayout) => void;
    arranging: boolean;
    onArrange: () => void;
    onLeaveArranging: () => void;
    arrangeRef: React.RefObject<HTMLButtonElement>;
    integrationDetails: boolean;
    persistentIntegration: boolean;
    onIntegration: () => void;
    onHistory: () => void;
    onBackToCurrent: () => void;
    // Data given instead of asked (the preview and the tests): the milestones, the agents of the project, the usage
    // and the workspace task.
    fixtures?: DashboardFixtures;
};

export type DashboardFixtures = {
    milestones?: MilestonesView;
    holds?: CompanionWorkProps["holds"];
    usage?: GaugesView;
    task?: TaskView;
};

type Columns = { columns: number; columnWidth: number; paired: boolean };

export function CompanionDashboard(props: CompanionDashboardProps) {
    const { arranging } = props;
    const t = useT();
    const [cols, setCols] = useState<Columns>({ columns: 1, columnWidth: 0, paired: false });
    const onColumns = useCallback(
        (next: Columns) =>
            setCols((cur) =>
                cur.columns === next.columns &&
                cur.paired === next.paired &&
                Math.abs(cur.columnWidth - next.columnWidth) < 1
                    ? cur
                    : next
            ),
        []
    );
    const flowRef = useRef<HTMLDivElement>(null);
    const zoneRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLSpanElement>(null);
    // While arranging every block, the main agent's included, is drawn from the draft: a move, a hide or an attach shows
    // in the dashboard's own layout as it is made (#2467).
    const session = useArrangeSession(props.layout, arranging, props.onSaveLayout, props.onLeaveArranging);
    const layout = session.layout;
    const usage = usageOf(layout);
    const [pickup, setPickup] = useState<Pickup>(null);
    const [zone, setZone] = useState<ZoneState>({ active: false, over: false });
    const onZone = useCallback((patch: Partial<ZoneState>) => setZone((cur) => ({ ...cur, ...patch })), []);
    const onPickupDone = useCallback(() => setPickup(null), []);
    const drag = useBlockDrag({
        arranging,
        flowRef,
        draftRef: session.draftRef,
        setDraft: session.setDraft,
        onZone,
        announce: session.announce,
        nameOf: (id) => t(SectionNameKeys[id]),
        pickup,
        onPickupDone,
    });
    const usageAgent = props.view.agent ?? "";
    const chrome = useArrangeChrome({
        arranging,
        session,
        flowRef,
        dragging: drag.dragging,
        onDetachDown: drag.onDetachDown,
        columns: cols.columns,
        columnWidth: cols.columnWidth,
        usageAgent,
    });
    useEffect(() => {
        if (arranging) {
            titleRef.current?.focus({ preventScroll: true });
        }
    }, [arranging]);
    // The usage's rows are chosen where the dashboard draws them: saved at once outside the mode, drafted with the layout
    // while arranging, which also hears the windows the provider reports for the block's settings (#2462).
    const rows = useMemo<UsageRowsProps>(
        () =>
            arranging
                ? { ...usageRowsProps(layout, usageAgent, session.setDraft), onListed: session.setWindows }
                : usageRowsProps(layout, usageAgent, props.onSaveLayout),
        [arranging, layout, usageAgent, session.setDraft, session.setWindows, props.onSaveLayout]
    );
    // The usage attached to the main agent (#2450) is drawn by the hero, through the usage's own source, so its refresh
    // and its states keep working.
    const attached = usage.attached;
    const permit = usePermitControl(props.target, props.view, mainName(mainAgentRow(props.view, props.agentState)));
    const hero = (parts?: UsageFrameParts) => (
        <CompanionHero
            {...props}
            permit={permit}
            onLeaveArranging={session.leave}
            usageBlockShown={usage.shown && !attached}
            usage={parts}
            attachedControls={chrome.attached}
            attachZone={
                arranging && usage.shown
                    ? { ref: zoneRef, active: zone.active, over: zone.over, attached: usage.attached }
                    : null
            }
        />
    );
    const pickUp = (picked: Pickup) => {
        setPickup(picked);
        props.onArrange();
    };
    // A block taller than its cap is unfolded or folded with the layout (#2477): saved at once, drafted while arranging.
    const { onSaveLayout } = props;
    const setDraft = session.setDraft;
    const capValue = useMemo(
        () => makeBlockCapValue(layout, arranging ? setDraft : onSaveLayout),
        [layout, arranging, setDraft, onSaveLayout]
    );
    return (
        <ArrangeContext.Provider value={chrome.value}>
            <BlockCapContext.Provider value={capValue}>
                <div
                    className="mt-cdash"
                    data-testid="companion"
                    data-columns={cols.columns}
                    data-arranging={arranging ? "" : undefined}
                    onClick={(e) => {
                        // A click on the dashboard's own ground, between the blocks, leaves the mode (#2459).
                        const ground =
                            e.target === e.currentTarget || (e.target as Element).classList.contains("mt-cdash-flow");
                        if (arranging && ground) {
                            session.leave();
                        }
                    }}
                    onKeyDown={
                        arranging
                            ? (e) => {
                                  if (e.key === "Escape") {
                                      e.stopPropagation();
                                      session.leave();
                                  }
                              }
                            : undefined
                    }
                >
                    {arranging ? (
                        <ArrangeBar
                            layout={layout}
                            titleRef={titleRef}
                            onReset={() => {
                                session.setDraft(resetLayout());
                                session.announce(t("companion.arrange.resetDone"));
                            }}
                            onDone={session.leave}
                        />
                    ) : null}
                    {attached ? (
                        <UsageSource
                            view={props.view}
                            target={props.target}
                            provider={props.provider}
                            agentState={props.agentState}
                            fixture={props.fixtures?.usage}
                            form="attached"
                            render={hero}
                            rows={rows}
                        />
                    ) : (
                        hero()
                    )}
                    <DashboardFlow
                        {...props}
                        layout={layout}
                        rows={rows}
                        cols={cols}
                        onColumns={onColumns}
                        flowRef={flowRef}
                        dragging={drag.dragging}
                        onArrangePointerDown={drag.onPointerDown}
                        onPickUp={pickUp}
                    />
                    {arranging ? <ArrangeNote note={session.note} /> : null}
                </div>
            </BlockCapContext.Provider>
        </ArrangeContext.Provider>
    );
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// tail: a hidden block's ghost at the end of the arranging mode's flow (#2467), which holds no rank.
type FlowItem = { id: string; full: boolean; tail?: boolean };

// Places the blocks it holds (its [data-flow-id] children) with flowLayout: each takes its column's width, then its
// measured height decides where the next goes. A structural change lets the blocks travel; growth follows at once.
function Flow({
    items,
    arranging,
    dragging,
    flowProps,
    onColumns,
    flowRef,
    children,
}: {
    items: FlowItem[];
    arranging: boolean;
    // The block a pointer carries (#2459): the drag places it, the flow leaves it where the pointer put it.
    dragging?: string;
    flowProps?: React.HTMLAttributes<HTMLDivElement>;
    onColumns: (cols: Columns) => void;
    flowRef: React.RefObject<HTMLDivElement>;
    children: React.ReactNode;
}) {
    const assign = useRef<FlowAssign>(null);
    // The blocks that hold a rank, as the last placement had them: the columns hold while they keep their order.
    const ranked = useRef<Pick<FlowItem, "id" | "full">[]>([]);
    const laid = useRef(false);
    const reflow = useRef<ReturnType<typeof setTimeout>>(null);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const draggingRef = useRef(dragging);
    draggingRef.current = dragging;
    const lastDragging = useRef<string>(null);
    const watch = useRef<FlowWatch>(null);
    const entering = useRef(new Set<ReturnType<typeof setTimeout>>());
    useEffect(
        () => () => {
            entering.current.forEach((timer) => clearTimeout(timer));
            entering.current.clear();
        },
        []
    );
    const place = useCallback(() => {
        const flow = flowRef.current;
        // The companion whose width the flow divides (the flow may sit in a wrapper of no box of its own).
        const companion = flow?.closest<HTMLElement>(".mt-cdash");
        if (flow == null || companion == null) {
            return;
        }
        const width = companion.clientWidth;
        if (width <= 0) {
            return;
        }
        // The blocks by the id the flow lays them out under, which a ghost of the pair's blocks does not share with the
        // block it stands for (#2467).
        const els = new Map<string, HTMLElement>();
        const layoutIds = new Map<string, string>();
        flow.querySelectorAll<HTMLElement>(FlowBlockSelector).forEach((el) => {
            const id = layoutIdOf(el.dataset.flowId, el.dataset.ghost != null);
            els.set(id, el);
            layoutIds.set(el.dataset.flowId, id);
        });
        const blocks = itemsRef.current
            .filter((i) => layoutIds.has(i.id))
            .map((i) => ({ ...i, id: layoutIds.get(i.id) }));
        const widths = flowLayout(
            blocks.map((b) => ({ ...b, height: 0 })),
            width
        );
        for (const p of widths.items) {
            const el = els.get(p.id);
            const w = `${p.width}px`;
            if (el.style.width !== w) {
                el.style.width = w;
            }
        }
        // The blocks keep their columns while the ones that hold a rank keep their order, as the arranging mode leaves
        // them when it opens (#2467); a block moved or widened is placed by its rank, so that a drop where the drag
        // shows a block gives the rank it was dropped at (#2459). A hidden block's ghost is placed after the others
        // every time.
        const order = blocks.filter((b) => !b.tail);
        const tails = new Set(blocks.filter((b) => b.tail).map((b) => b.id));
        const previous =
            assign.current != null && keepsColumns(ranked.current, order)
                ? {
                      key: assign.current.key,
                      columns: Object.fromEntries(
                          Object.entries(assign.current.columns).filter(([id]) => !tails.has(id))
                      ),
                  }
                : undefined;
        const r = flowLayout(
            blocks.map((b) => ({ ...b, height: els.get(b.id).offsetHeight })),
            width,
            previous
        );
        ranked.current = order;
        const carried = layoutIds.get(draggingRef.current) ?? draggingRef.current;
        const settled = lastDragging.current != null && draggingRef.current == null;
        lastDragging.current = draggingRef.current ?? null;
        if (laid.current && ((assign.current != null && assign.current.key !== r.assign.key) || settled)) {
            flow.dataset.reflowing = "";
            clearTimeout(reflow.current);
            reflow.current = setTimeout(() => {
                delete flow.dataset.reflowing;
                flow.dispatchEvent(new Event(FlowPlacedEvent));
            }, 300);
        }
        assign.current = r.assign;
        for (const p of r.items) {
            const el = els.get(p.id);
            if (p.id === carried) {
                const slot = flow.querySelector<HTMLElement>(":scope > .mt-cdash-slot");
                if (slot != null) {
                    slot.style.width = `${p.width}px`;
                    slot.style.height = `${el.offsetHeight}px`;
                    const to = `translate(${p.x}px, ${p.y}px)`;
                    if (slot.dataset.placed == null) {
                        slot.style.transition = "none";
                        slot.style.transform = to;
                        void slot.offsetWidth;
                        slot.style.transition = "";
                        slot.dataset.placed = "";
                    } else if (slot.style.transform !== to) {
                        slot.style.transform = to;
                    }
                }
                continue;
            }
            const transform = `translate(${p.x}px, ${p.y}px)`;
            if (el.dataset.placed == null) {
                el.style.transition = "none";
                el.style.transform = transform;
                void el.offsetWidth;
                el.style.transition = "";
                el.dataset.placed = "";
                if (laid.current) {
                    el.dataset.entering = "";
                    const timer = setTimeout(() => {
                        entering.current.delete(timer);
                        delete el.dataset.entering;
                    }, 400);
                    entering.current.add(timer);
                }
            } else if (el.style.transform !== transform) {
                el.style.transform = transform;
            }
        }
        flow.style.height = `${r.height}px`;
        laid.current = true;
        onColumns({ columns: r.columns, columnWidth: r.columnWidth, paired: r.paired });
        flow.dispatchEvent(new Event(FlowPlacedEvent));
    }, [onColumns]);
    // A block a section draws on its own state comes, changes or goes with no render of the flow (#2466): the watch
    // places it before it is painted (companion-flow-watch.ts).
    useLayoutEffect(() => {
        const flow = flowRef.current;
        const w = watchFlow(flow, flow?.closest(".mt-cdash"), place);
        watch.current = w;
        return () => {
            w.stop();
            watch.current = null;
            clearTimeout(reflow.current);
        };
    }, [place]);
    // After each render: the blocks that appeared are observed, those that left are let go, and everything is placed
    // again.
    useLayoutEffect(() => {
        watch.current?.sync();
        place();
    });
    return (
        <div
            {...flowProps}
            ref={flowRef}
            className="mt-cdash-flow"
            data-testid="companion-flow"
            data-arranging={arranging ? "" : undefined}
            data-dragging={dragging ?? undefined}
        >
            {children}
            {dragging != null ? <div className="mt-cdash-slot" aria-hidden="true" /> : null}
        </div>
    );
}

// A press on the icon of a block, held for LongPressMs nearly where it began, picks the block up (#2459): it hands the
// arranging mode the block and the pointer, which goes on dragging it without lifting. A shorter press, or one that
// moves, does nothing, and a click on the icon is the click it always was. One press at a time, the primary pointer's.
function useLongPressPickUp(onPickUp: (pickup: Pickup) => void): React.HTMLAttributes<HTMLElement> {
    const stop = useRef<() => void>(null);
    const pick = useRef(onPickUp);
    pick.current = onPickUp;
    useEffect(() => () => stop.current?.(), []);
    return {
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            const tile = (e.target as Element).closest?.(".mt-cb-tile") as HTMLElement;
            const block = tile?.closest<HTMLElement>("[data-flow-id]");
            const id = block?.dataset.flowId;
            if (block == null || !SectionIdSet.has(id) || !startsPress(e.nativeEvent)) {
                return;
            }
            stop.current?.();
            const pointerId = e.pointerId;
            const box = block.getBoundingClientRect();
            const grab = { x: e.clientX - box.left, y: e.clientY - box.top };
            const listeners: [string, (ev: PointerEvent) => void][] = [];
            // The ring that fills round the icon while the press lasts (companion-dashboard.css).
            tile.setAttribute("data-pressing", "");
            const end = () => {
                tile.removeAttribute("data-pressing");
                listeners.forEach(([type, fn]) => window.removeEventListener(type, fn));
                listeners.length = 0;
                stop.current = null;
            };
            const press = startLongPress({
                x: e.clientX,
                y: e.clientY,
                onFire: (at) => {
                    end();
                    const picked: Pickup = {
                        id: id as CompanionSectionId,
                        pointerId,
                        x: at.x,
                        y: at.y,
                        grab,
                        released: false,
                    };
                    // Until the arranging mode takes the pointer over, a release is only noted.
                    const note = (ev: PointerEvent) => {
                        if (ev.pointerId !== pointerId) {
                            return;
                        }
                        picked.released = true;
                        window.removeEventListener("pointerup", note);
                        window.removeEventListener("pointercancel", note);
                    };
                    window.addEventListener("pointerup", note);
                    window.addEventListener("pointercancel", note);
                    pick.current(picked);
                },
            });
            const watch = (type: string, fn: (ev: PointerEvent) => void) => {
                listeners.push([type, fn]);
                window.addEventListener(type, fn);
            };
            watch("pointermove", (ev) => ev.pointerId === pointerId && press.move(ev.clientX, ev.clientY));
            watch("pointerup", (ev) => {
                if (ev.pointerId === pointerId) {
                    press.release();
                    end();
                }
            });
            watch("pointercancel", (ev) => {
                if (ev.pointerId === pointerId) {
                    press.cancel();
                    end();
                }
            });
            stop.current = () => {
                press.cancel();
                end();
            };
        },
        // A long press on a touch screen or a pen opens the system's menu, over the block it picks up.
        onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
            if ((e.target as Element).closest?.(".mt-cb-tile") != null) {
                e.preventDefault();
            }
        },
    };
}

// The blocks of the dashboard, in the flow, the same ones in the normal view and while arranging (#2467): the arranging
// mode only adds the hidden blocks' ghosts after them, and a ghost in the place of a block with nothing to show, and
// leaves the rest to the controls the blocks read from the arranging context.
function DashboardFlow(
    props: CompanionDashboardProps & {
        rows: UsageRowsProps;
        cols: Columns;
        onColumns: (cols: Columns) => void;
        flowRef: React.RefObject<HTMLDivElement>;
        dragging: CompanionSectionId;
        onArrangePointerDown: (e: React.PointerEvent<HTMLElement>) => void;
        onPickUp: (pickup: Pickup) => void;
    }
) {
    const { view, agentState, target, layout, cols, arranging, flowRef } = props;
    const t = useT();
    const pickUpProps = useLongPressPickUp(props.onPickUp);
    const entries = flowEntries(layout, arranging);
    const ranked = entries.filter((e) => !e.tail);
    const shows = (id: CompanionSectionId) => ranked.some((e) => e.id === id);
    const items: FlowItem[] = entries.map((e) => ({ id: e.id, full: e.full, tail: e.tail }));
    const now = Date.now();
    const lead = mainName(mainAgentRow(view, agentState));
    const taskFrame: TaskFrameFn = ({ tools, body, other }) => (
        <CompanionBlock
            flowId="task"
            label={t("companion.task.title")}
            icon={SectionTiles.task}
            tools={tools}
            data-other-session={other ? "" : undefined}
        >
            {body}
        </CompanionBlock>
    );
    const blocks: Partial<Record<CompanionSectionId, React.ReactNode>> = {
        permission: (
            <PermissionBlock key="permission" target={target} view={view} agentState={agentState} lead={lead} />
        ),
        usage: (
            <UsageBlock
                key="usage"
                view={view}
                target={target}
                provider={props.provider}
                agentState={agentState}
                fixture={props.fixtures?.usage}
                minimal={layout.find((p) => p.id === "usage")?.minimal === true}
                rows={props.rows}
            />
        ),
        topics: (
            <CompanionBlock
                key="topics"
                flowId="topics"
                label={t("companion.topics.title")}
                icon={SectionTiles.topics}
                chips={(view.topics?.length ?? 0) > 0 ? <CountChip>{view.topics.length}</CountChip> : null}
                rows=".mt-cdash-topic"
                data-testid="companion-topics-block"
            >
                <RecentTopicsSection view={view} now={now} />
            </CompanionBlock>
        ),
        answer: <AnswerBlock key={`answer:${view.session?.path}`} target={target} view={view} />,
        task:
            props.fixtures?.task != null ? (
                <WorkspaceTaskCard
                    key="task"
                    view={props.fixtures.task}
                    session={taskSessionLabel(props.fixtures.task, view)}
                    now={now}
                    confirming={false}
                    actionError={null}
                    onOpen={() => {}}
                    onEdit={() => {}}
                    onAskClear={() => {}}
                    onCancelClear={() => {}}
                    onClear={() => {}}
                    frame={taskFrame}
                    other={true}
                />
            ) : (
                <WorkspaceTaskSection
                    key="task"
                    target={target}
                    companionId={props.companionId}
                    companion={view}
                    frame={taskFrame}
                />
            ),
        files: (
            <FilesSection
                key={`files:${view.session?.path}`}
                target={target}
                companionId={props.companionId}
                files={view.files}
                folder={props.folder}
                home={getHomeDir()}
                frame={({ tools, body, count }) => (
                    <CompanionBlock
                        flowId="files"
                        label={t("companion.files.title")}
                        icon={SectionTiles.files}
                        chips={count > 0 ? <CountChip>{count}</CountChip> : null}
                        tools={tools}
                        rows=".mt-cdash-file"
                    >
                        {body}
                    </CompanionBlock>
                )}
            />
        ),
    };
    const pairAt = ranked.findIndex((e) => e.id === "tasks" || e.id === "agents");
    return (
        <Flow
            items={items}
            arranging={arranging}
            dragging={props.dragging}
            flowProps={arranging ? { onPointerDown: props.onArrangePointerDown } : pickUpProps}
            onColumns={props.onColumns}
            flowRef={flowRef}
        >
            {entries.map((e, i) => {
                if (e.tail) {
                    return <ArrangeGhost key={`hidden:${e.id}`} id={e.id} kind="hidden" />;
                }
                if (e.id === "tasks" || e.id === "agents") {
                    return i === pairAt ? (
                        <CompanionWork
                            key="pair"
                            view={view}
                            agentState={agentState}
                            dir={props.dir}
                            now={now}
                            showTasks={shows("tasks")}
                            showAgents={shows("agents")}
                            width={
                                cols.columns >= 2 && items.find((it) => it.id === "tasks")?.full ? 0 : cols.columnWidth
                            }
                            paired={cols.paired}
                            flowRef={flowRef}
                            lead={lead}
                            milestones={props.fixtures?.milestones}
                            holds={props.fixtures?.holds}
                        />
                    ) : null;
                }
                return blocks[e.id] ?? null;
            })}
        </Flow>
    );
}

type UsageSourceProps = {
    view: CompanionView;
    target: string;
    provider: string;
    agentState: AgentStateInfo;
    fixture?: GaugesView;
    form: UsageForm;
    render: UsageFrame;
    // The rows the developer chose to show, and how to change them (#2462).
    rows?: UsageRowsProps;
};

// Where the plan usage comes from (the session's other provider, a fixture, the agent's own gauges), given to `render`
// as the parts a block draws it with: the usage block's frame stands alone in the flow, the main agent's block takes
// them when the usage is attached to it (#2450). A usage with nothing to show is rendered as the state "hidden".
function UsageSource({ view, target, provider, agentState, fixture, form, render, rows }: UsageSourceProps) {
    if (provider) {
        return render({
            tools: null,
            body: (
                <ProviderUsageNote
                    provider={provider}
                    native={agentState?.nativeprovider ?? ""}
                    bare={form === "attached"}
                />
            ),
            state: "provider",
        });
    }
    if (fixture != null) {
        const none = () => {};
        return (
            <PlanUsageBody
                view={withRowChoice(fixture, rows?.hidden ?? [])}
                rows={rows}
                onShow={none}
                onHide={none}
                onRefresh={none}
                frame={render}
                form={form}
            />
        );
    }
    if (view.usage == null || !view.agent) {
        return render({ tools: null, body: null, state: "hidden" });
    }
    return <PlanUsageSection target={target} agent={view.agent} frame={render} form={form} rows={rows} />;
}

// The usage block, standing on its own in the flow. Minimal (#2450), it draws the window rows alone; its foot link, the
// usage page, then rides in its tools, with the refresh, so no row of the block is spent on it. With nothing to show it
// draws nothing, but for the arranging mode's ghost (#2467).
function UsageBlock({
    view,
    target,
    provider,
    agentState,
    fixture,
    minimal,
    rows,
}: Omit<UsageSourceProps, "form" | "render"> & { minimal: boolean }) {
    const t = useT();
    const action = usageAction(view);
    const foot =
        action && !minimal ? (
            <FootLink onClick={() => openUsagePage(view)} testId="companion-usage">
                {t("companion.dash.openUsage")}
            </FootLink>
        ) : null;
    const frame: UsageFrame = ({ tools, body, state }) =>
        state === "hidden" ? (
            <ArrangeGhost id="usage" kind="when" />
        ) : (
            <CompanionBlock
                flowId="usage"
                label={t("companion.gauges.title")}
                icon={SectionTiles.usage}
                tools={
                    minimal ? (
                        <>
                            <UsageButton view={view} className="mt-cb-tool" />
                            {tools}
                        </>
                    ) : (
                        tools
                    )
                }
                foot={foot}
                data-testid="companion-usage-block"
                data-form={minimal ? "minimal" : "full"}
            >
                {body}
            </CompanionBlock>
        );
    return (
        <UsageSource
            view={view}
            target={target}
            provider={provider}
            agentState={agentState}
            fixture={fixture}
            form={minimal ? "minimal" : "full"}
            render={frame}
            rows={rows}
        />
    );
}

// The latest answer follows the session; browsing back pins an earlier one until "Latest".
function AnswerBlock({ target, view }: { target: string; view: CompanionView }) {
    const t = useT();
    const [pinned, setPinned] = useState<number>(null);
    const [earlier, setEarlier] = useState<CompanionAnswer>(null);
    const [error, setError] = useState<string>(null);
    const answers = view.answers ?? [];
    const latest = view.latest;
    useEffect(() => {
        setEarlier(null);
        setError(null);
        if (pinned == null) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const a = await companionCall<CompanionAnswer>(CompanionAnswerCommand, {
                    blockid: target,
                    index: pinned,
                });
                if (!cancelled) {
                    setEarlier(a);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, pinned]);
    const shown = pinned == null ? latest : earlier;
    const current = shown?.index ?? latest?.index;
    const pos = answers.findIndex((a) => a.index === current);
    const go = (step: -1 | 1) => {
        const next = neighbourAnswer(answers, current, step);
        if (next == null) {
            return;
        }
        setPinned(next === latest?.index ? null : next);
    };
    const markdown = useMemo(() => companionMarkdown(shown?.markdown), [shown?.markdown]);
    const tools =
        latest == null ? null : (
            <>
                <BlockTool label={t("companion.answer.earlier")} disabled={pos <= 0} onClick={() => go(-1)}>
                    <i className="fa fa-solid fa-chevron-left" aria-hidden="true" />
                </BlockTool>
                <span className="mt-cb-tool-meta" data-testid="companion-answer-pos">
                    {pos + 1} / {answers.length}
                </span>
                <BlockTool
                    label={t("companion.answer.later")}
                    disabled={pos < 0 || pos >= answers.length - 1}
                    onClick={() => go(1)}
                >
                    <i className="fa fa-solid fa-chevron-right" aria-hidden="true" />
                </BlockTool>
                {pinned != null ? (
                    <button type="button" className="mt-cb-tool" onClick={() => setPinned(null)}>
                        {t("companion.answer.latestButton")}
                    </button>
                ) : null}
                <CopyTool
                    label={t("companion.answer.copy")}
                    onCopy={() => fireAndForget(() => navigator.clipboard.writeText(shown?.markdown ?? ""))}
                />
            </>
        );
    return (
        <CompanionBlock
            flowId="answer"
            label={pinned == null ? t("companion.answer.latest") : t("companion.answer.earlier")}
            icon={SectionTiles.answer}
            tools={tools}
            data-testid="companion-answer-block"
        >
            {latest == null ? (
                <div className="mt-cb-empty">{t("companion.answer.none")}</div>
            ) : (
                <>
                    {error ? <div className="text-12 text-danger">{error}</div> : null}
                    <div
                        className="mt-cdash-answer"
                        data-image-at={shown?.at || undefined}
                        data-testid="companion-answer"
                    >
                        {shown ? (
                            <AnswerMarkdown markdown={markdown} />
                        ) : (
                            <div className="text-12 text-muted">
                                <DominoLoader className="mr-1.5" />
                                {t("companion.loading")}
                            </div>
                        )}
                    </div>
                </>
            )}
        </CompanionBlock>
    );
}

const AnswerMarkdown = memo(({ markdown }: { markdown: string }) => {
    return <Markdown text={markdown} scrollable={false} fontSizeOverride={13} fixedFontSizeOverride={12} />;
});
AnswerMarkdown.displayName = "AnswerMarkdown";
