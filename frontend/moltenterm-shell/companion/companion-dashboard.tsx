// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion as the main agent's dashboard (FR-SHELL-018, #2441): the hero (the agent, its session and its plan),
// then every section as the same block in a flow of one to three columns (companion-flow-model.ts), the milestone and
// the agents at work side by side as a linked pair, and the arranging mode in place. Loaded on demand, out of the
// startup bundle (companion-view.tsx).

import { Markdown } from "@/app/element/markdown";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { Bot, ClipboardCheck, FileText, Flag, FolderGit2, Gauge, MessagesSquare } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { goToAgent } from "../agent-info/agent-info-hooks";
import type { AgentStateInfo } from "../agent-state-model";
import { useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { StateMark } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { getHomeDir } from "../tab-identity-ui";
import { autoScrollStep } from "../workspace-rail-drag";
import { mainName } from "./companion-agents";
import {
    dropSection,
    handleTarget,
    makeLayoutCommit,
    moveSection,
    positionOf,
    resetLayout,
    SectionNameKeys,
    usageSummaryKey,
} from "./companion-arrange-model";
import { BlockTool, CompanionBlock, CopyTool, CountChip, FootLink } from "./companion-block";
import {
    BlockOption,
    BlockOptionKey,
    BlockPrefKey,
    optionAnnouncement,
    optionsOf,
    PrefDefaults,
    setLayoutOption,
} from "./companion-block-options";
import { BlockSettings } from "./companion-block-settings";
import "./companion-dashboard.css";
import {
    dragCorner,
    dropIndexAt,
    passedDragStart,
    Point,
    pointInBox,
    startLongPress,
    startsPress,
    ZoneSlackPx,
} from "./companion-drag-model";
import { FilesSection } from "./companion-files";
import { FlowAssign, flowLayout, FlowPlacedEvent } from "./companion-flow-model";
import {
    PlanUsageBody,
    PlanUsageSection,
    ProviderUsageNote,
    UsageForm,
    UsageFrame,
    UsageFrameParts,
} from "./companion-gauges";
import type { GaugesView } from "./companion-gauges-model";
import { CompanionHero } from "./companion-hero";
import {
    CompanionLayout,
    CompanionSectionId,
    CompanionSectionIds,
    isDefaultLayout,
    normalizeLayout,
    usageOf,
} from "./companion-layout";
import { MilestonesView } from "./companion-milestone-model";
import {
    CompanionAnswer,
    CompanionAnswerCommand,
    companionMarkdown,
    CompanionRoute,
    CompanionView,
    neighbourAnswer,
    permissionRequest,
    usageAction,
} from "./companion-model";
import { PermissionRequestCard, permissionTerminalOf } from "./companion-permission";
import { useBlockPrefs } from "./companion-prefs";
import { RecentTopicsSection } from "./companion-recap";
import { agentsView, finishedLabel, mainAgentRow } from "./companion-recap-model";
import { TaskFrameFn, WorkspaceTaskCard, WorkspaceTaskSection } from "./companion-task";
import { taskSessionLabel, TaskView } from "./companion-task-model";
import { CompactBlockPx } from "./companion-tasks";
import { CloseTipsEvent } from "./companion-tips-model";
import { openUsagePage, UsageButton } from "./companion-usage";
import { CompanionWork, CompanionWorkProps } from "./companion-work";

const RpcTimeoutMs = 5000;
// A zero-width space: appended to a sentence, it makes the live region's text new without changing what is read.
const InvisibleMark = String.fromCharCode(0x200b);
// Past this many characters an answer shows its first lines over a fade, and "Read all" grows the block.
const LongAnswer = 600;

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

// What a long press on a block's icon hands to the arranging mode (#2459): the block it picked up, the pointer that holds
// it, where that pointer is, and where on the block it took hold. `released` says the pointer went up before the mode
// had mounted, so that nothing is carried that nobody holds.
export type Pickup = {
    id: CompanionSectionId;
    pointerId: number;
    x: number;
    y: number;
    grab: Point;
    released: boolean;
};

// What the arranging mode tells the hero about the zone: the drafted usage block shows and is attached, and the
// drag carries it, over the zone or not.
type ZoneState = { shown: boolean; attached: boolean; active: boolean; over: boolean };

const SectionTiles: Record<CompanionSectionId, React.ReactNode> = {
    permission: <StateMark kind="waiting" />,
    tasks: <Flag strokeWidth={2} aria-hidden />,
    agents: <Bot strokeWidth={2} aria-hidden />,
    usage: <Gauge strokeWidth={2} aria-hidden />,
    topics: <MessagesSquare strokeWidth={2} aria-hidden />,
    answer: <FileText strokeWidth={2} aria-hidden />,
    task: <ClipboardCheck strokeWidth={2} aria-hidden />,
    files: <FolderGit2 strokeWidth={2} aria-hidden />,
};

export function CompanionDashboard(props: CompanionDashboardProps) {
    const { arranging } = props;
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
    // The usage attached to the main agent (#2450) is drawn by the hero, through the usage's own source, so its refresh
    // and its states keep working; while arranging every block, this one included, is a folded line of the list.
    const usage = usageOf(props.layout);
    const attached = usage.attached && !arranging;
    const [pickup, setPickup] = useState<Pickup>(null);
    const [zone, setZone] = useState<ZoneState>({
        shown: usage.shown,
        attached: usage.attached,
        active: false,
        over: false,
    });
    const zoneRef = useRef<HTMLDivElement>(null);
    const hero = (parts?: UsageFrameParts) => (
        <CompanionHero
            {...props}
            usageBlockShown={usage.shown && !attached}
            usage={parts}
            attachZone={
                arranging && zone.shown
                    ? { ref: zoneRef, active: zone.active, over: zone.over, attached: zone.attached }
                    : null
            }
        />
    );
    const pickUp = (picked: Pickup) => {
        setPickup(picked);
        props.onArrange();
    };
    const onPickupDone = useCallback(() => setPickup(null), []);
    const onZone = useCallback((patch: Partial<ZoneState>) => setZone((cur) => ({ ...cur, ...patch })), []);
    return (
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
                    props.onLeaveArranging();
                }
            }}
        >
            {attached ? (
                <UsageSource
                    view={props.view}
                    target={props.target}
                    provider={props.provider}
                    agentState={props.agentState}
                    fixture={props.fixtures?.usage}
                    form="attached"
                    render={hero}
                />
            ) : (
                hero()
            )}
            {arranging ? (
                <ArrangingFlow
                    {...props}
                    cols={cols}
                    onColumns={onColumns}
                    pickup={pickup}
                    onPickupDone={onPickupDone}
                    zoneRef={zoneRef}
                    onZone={onZone}
                />
            ) : (
                <SessionFlow {...props} cols={cols} onColumns={onColumns} onPickUp={pickUp} />
            )}
        </div>
    );
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type FlowItem = { id: string; full: boolean };

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
    const laid = useRef(false);
    const reflow = useRef<ReturnType<typeof setTimeout>>(null);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const draggingRef = useRef(dragging);
    draggingRef.current = dragging;
    const lastDragging = useRef<string>(null);
    const observer = useRef<ResizeObserver>(null);
    // The blocks the observer watches, so a block that leaves the flow is let go.
    const observed = useRef(new Set<Element>());
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
        const els = new Map<string, HTMLElement>();
        flow.querySelectorAll<HTMLElement>(":scope > [data-flow-id]").forEach((el) => els.set(el.dataset.flowId, el));
        const blocks = itemsRef.current.filter((i) => els.has(i.id));
        const widths = flowLayout(
            blocks.map((b) => ({ ...b, height: 0 })),
            width,
            undefined,
            { arranging }
        );
        for (const p of widths.items) {
            const el = els.get(p.id);
            const w = `${p.width}px`;
            if (el.style.width !== w) {
                el.style.width = w;
            }
        }
        // While arranging, a block's column follows its rank at once, so that dropping a block where the drag shows
        // it gives the rank it was dropped at (#2459); the live flow keeps each block's column (companion-flow-model.ts).
        const r = flowLayout(
            blocks.map((b) => ({ ...b, height: els.get(b.id).offsetHeight })),
            width,
            arranging ? undefined : assign.current,
            { arranging }
        );
        const carried = draggingRef.current;
        const settled = lastDragging.current != null && carried == null;
        lastDragging.current = carried ?? null;
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
    }, [arranging, onColumns]);
    useLayoutEffect(() => {
        const flow = flowRef.current;
        if (flow == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const ro = new ResizeObserver(() => place());
        observer.current = ro;
        observed.current.clear();
        if (flow.closest(".mt-cdash")) {
            ro.observe(flow.closest(".mt-cdash"));
        }
        return () => {
            ro.disconnect();
            observer.current = null;
            observed.current.clear();
            clearTimeout(reflow.current);
        };
    }, [place]);
    // After each render: the blocks that appeared are observed, those that left are let go, and everything is placed
    // again.
    useLayoutEffect(() => {
        const ro = observer.current;
        if (ro != null) {
            const now = new Set<Element>(flowRef.current?.querySelectorAll(":scope > [data-flow-id]") ?? []);
            observed.current.forEach((el) => {
                if (!now.has(el)) {
                    ro.unobserve(el);
                    observed.current.delete(el);
                }
            });
            now.forEach((el) => {
                if (!observed.current.has(el)) {
                    ro.observe(el);
                    observed.current.add(el);
                }
            });
        }
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

const SectionIdSet = new Set<string>(CompanionSectionIds);

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

function SessionFlow(
    props: CompanionDashboardProps & {
        cols: Columns;
        onColumns: (cols: Columns) => void;
        onPickUp: (pickup: Pickup) => void;
    }
) {
    const { view, agentState, target, layout, cols } = props;
    const t = useT();
    const flowRef = useRef<HTMLDivElement>(null);
    const pickUpProps = useLongPressPickUp(props.onPickUp);
    const placements = normalizeLayout(layout);
    // An attached usage leaves the flow for the main agent's block (#2450); its placement keeps its rank for the day it
    // comes back.
    const visible = placements.filter((p) => !p.hidden && !(p.id === "usage" && p.attached));
    const shows = (id: CompanionSectionId) => visible.some((p) => p.id === id);
    const items: FlowItem[] = visible.map((p) => ({ id: p.id, full: p.span === "full" }));
    const now = Date.now();
    const lead = mainName(mainAgentRow(view, agentState));
    const request = permissionRequest(view.pending, agentState?.state);
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
        permission:
            request != null ? (
                <CompanionBlock
                    key="permission"
                    flowId="permission"
                    tone="waiting"
                    label={t("companion.permissionRequest")}
                    icon={SectionTiles.permission}
                >
                    <PermissionRequestCard
                        request={request}
                        t={t}
                        agent={lead}
                        onShowTerminal={() => fireAndForget(() => goToAgent(permissionTerminalOf(target, agentState)))}
                    />
                </CompanionBlock>
            ) : null,
        usage: (
            <UsageBlock
                key="usage"
                view={view}
                target={target}
                provider={props.provider}
                agentState={agentState}
                fixture={props.fixtures?.usage}
                minimal={placements.find((p) => p.id === "usage")?.minimal === true}
            />
        ),
        topics: (
            <CompanionBlock
                key="topics"
                flowId="topics"
                label={t("companion.topics.title")}
                icon={SectionTiles.topics}
                chips={(view.topics?.length ?? 0) > 0 ? <CountChip>{view.topics.length}</CountChip> : null}
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
                    >
                        {body}
                    </CompanionBlock>
                )}
            />
        ),
    };
    const pairAt = visible.findIndex((p) => p.id === "tasks" || p.id === "agents");
    return (
        <Flow items={items} arranging={false} flowProps={pickUpProps} onColumns={props.onColumns} flowRef={flowRef}>
            {visible.map((p, i) => {
                if (p.id === "tasks" || p.id === "agents") {
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
                return blocks[p.id] ?? null;
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
};

// Where the plan usage comes from (the session's other provider, a fixture, the agent's own gauges), given to `render`
// as the parts a block draws it with: the usage block's frame stands alone in the flow, the main agent's block takes
// them when the usage is attached to it (#2450). A usage with nothing to show is rendered as the state "hidden".
function UsageSource({ view, target, provider, agentState, fixture, form, render }: UsageSourceProps) {
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
        return <PlanUsageBody view={fixture} onShow={none} onHide={none} onRefresh={none} frame={render} form={form} />;
    }
    if (view.usage == null || !view.agent) {
        return render({ tools: null, body: null, state: "hidden" });
    }
    return <PlanUsageSection target={target} agent={view.agent} frame={render} form={form} />;
}

// The usage block, standing on its own in the flow. Minimal (#2450), it draws the window rows alone; its foot link, the
// usage page, then rides in its tools, with the refresh, so no row of the block is spent on it.
function UsageBlock({
    view,
    target,
    provider,
    agentState,
    fixture,
    minimal,
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
        state === "hidden" ? null : (
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
        />
    );
}

// The latest answer follows the session; browsing back pins an earlier one until "Latest".
function AnswerBlock({ target, view }: { target: string; view: CompanionView }) {
    const t = useT();
    const [pinned, setPinned] = useState<number>(null);
    const [earlier, setEarlier] = useState<CompanionAnswer>(null);
    const [error, setError] = useState<string>(null);
    const [full, setFull] = useState(false);
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
    const long = (shown?.markdown?.length ?? 0) > LongAnswer;
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
                        data-folded={long && !full ? "" : undefined}
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
                    {long ? (
                        <button
                            type="button"
                            className="mt-cdash-readmore"
                            aria-expanded={full}
                            onClick={(e) => {
                                e.stopPropagation();
                                setFull(!full);
                            }}
                            data-testid="companion-answer-more"
                        >
                            {full ? t("companion.dash.readLess") : t("companion.dash.readAll")}
                        </button>
                    ) : null}
                </>
            )}
        </CompanionBlock>
    );
}

const AnswerMarkdown = memo(({ markdown }: { markdown: string }) => {
    return <Markdown text={markdown} scrollable={false} fontSizeOverride={13} fixedFontSizeOverride={12} />;
});
AnswerMarkdown.displayName = "AnswerMarkdown";

// ── Arranging ────────────────────────────────────────────────────────────────────────────────────────────────────────

// What each block says while arranging, in one line: what it holds now, or when it shows.
function useSummaries(view: CompanionView, agentState: AgentStateInfo, provider: string) {
    const t = useT();
    const tCount = useTCount();
    const now = Date.now();
    const agents = agentsView(view, agentState, now);
    const running = agents.rows.filter((r) => !r.main).length;
    const ended = finishedLabel(agents.finished, agents.failed);
    const request = permissionRequest(view.pending, agentState?.state);
    const lead = mainName(mainAgentRow(view, agentState));
    const topics = view.topics?.length ?? 0;
    const answers = view.answers?.length ?? 0;
    const files = view.files?.length ?? 0;
    const usage = !!provider || (view.usage != null && !!view.agent);
    const sums: Record<CompanionSectionId, { text: string; absent?: boolean }> = {
        permission: request
            ? { text: `${t("companion.dash.wantsToRun", { name: lead })} ${request.tool}` }
            : { text: t("companion.dash.sum.permission"), absent: true },
        tasks: { text: t("companion.dash.sum.tasks") },
        agents: {
            text: [tCount("companion.dash.sum.agents", running, { count: running }), ended]
                .filter((s) => !!s)
                .join(" · "),
        },
        usage: usage
            ? { text: t("companion.dash.sum.usage") }
            : { text: t("companion.dash.sum.usageNone"), absent: true },
        topics:
            topics > 0
                ? { text: tCount("companion.dash.sum.topics", topics, { count: topics }) }
                : { text: t("companion.topics.empty"), absent: true },
        answer:
            answers > 0
                ? { text: tCount("companion.dash.sum.answers", answers, { count: answers }) }
                : { text: t("companion.answer.none"), absent: true },
        task: { text: t("companion.dash.sum.task") },
        files:
            files > 0
                ? { text: tCount("companion.dash.sum.files", files, { count: files }) }
                : { text: t("companion.files.none"), absent: true },
    };
    return sums;
}

function scrollParentOf(el: HTMLElement): HTMLElement {
    for (let p = el?.parentElement; p != null; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) {
            return p;
        }
    }
    return null;
}

type BlockDragOptions = {
    flowRef: React.RefObject<HTMLDivElement>;
    zoneRef: React.RefObject<HTMLDivElement>;
    draftRef: React.RefObject<CompanionLayout>;
    setDraft: (layout: CompanionLayout) => void;
    onZone: (zone: Partial<ZoneState>) => void;
    announce: (text: string) => void;
    nameOf: (id: CompanionSectionId) => string;
    pickup: Pickup;
    onPickupDone: () => void;
};

// Carrying a block with a pointer while arranging (#2459). A press on a block's header is a click until the pointer
// moves a few pixels, then the block is carried: it follows the pointer, the others make room as the flow places the
// drafted order (companion-drag-model.ts says which rank the pointer is at), and the drop sets the rank. The usage block
// dropped on the main agent's block is attached, and one that leaves it is detached. Escape puts the block back where
// the drag found it. The listeners are the window's, so that a block picked up by a long press, whose first block was
// replaced by the arranging mode's, goes on being carried by the same pointer.
function useBlockDrag(options: BlockDragOptions) {
    const t = useT();
    const [dragging, setDragging] = useState<CompanionSectionId>(null);
    const stop = useRef<() => void>(null);
    const followRef = useRef<() => void>(null);
    // The block goes under the pointer again once what the drag changed has taken its room (the zone, the slot).
    useLayoutEffect(() => followRef.current?.(), [dragging]);
    const latest = useRef(options);
    latest.current = options;
    const tRef = useRef(t);
    tRef.current = t;
    useEffect(() => () => stop.current?.(), []);

    const arm = useCallback((id: CompanionSectionId, pointerId: number, from: Point, grab: Point, carried: boolean) => {
        stop.current?.();
        const o = () => latest.current;
        const flow = o().flowRef.current;
        if (flow == null) {
            return;
        }
        const blockOf = (blockId: string) => flow.querySelector<HTMLElement>(`:scope > [data-flow-id="${blockId}"]`);
        const snapshot = o().draftRef.current;
        const scroller = scrollParentOf(flow);
        const listeners: [string, EventListener, boolean?][] = [];
        let last = from;
        let begun = false;
        let over = false;
        let frame = 0;
        const setDraft = (next: CompanionLayout) => {
            o().draftRef.current = next;
            o().setDraft(next);
        };
        const follow = () => {
            const el = blockOf(id);
            const f = o().flowRef.current;
            if (el == null || f == null) {
                return;
            }
            const origin = f.getBoundingClientRect();
            const corner = dragCorner({ x: last.x - origin.left, y: last.y - origin.top }, grab);
            el.style.transform = `translate(${corner.x}px, ${corner.y}px)`;
            // The whole main agent's block takes the drop, so that a drop near the zone counts.
            const hero = id === "usage" ? f.closest(".mt-cdash")?.querySelector<HTMLElement>(".mt-cdash-hero") : null;
            const box = hero?.getBoundingClientRect();
            const nowOver =
                box != null &&
                pointInBox(last, { x: box.left, y: box.top, width: box.width, height: box.height }, ZoneSlackPx);
            if (nowOver !== over) {
                over = nowOver;
                o().onZone({ over });
            }
            const width = f.closest<HTMLElement>(".mt-cdash")?.clientWidth ?? 0;
            if (over || width <= 0) {
                return;
            }
            const draft = o().draftRef.current;
            const blocks = draft.map((p) => ({
                id: p.id,
                full: p.span === "full",
                height: blockOf(p.id)?.offsetHeight ?? 0,
            }));
            const index = dropIndexAt(blocks, id, width, {
                x: corner.x + el.offsetWidth / 2,
                y: corner.y + el.offsetHeight / 2,
            });
            const at = draft.findIndex((p) => p.id === id);
            if (index >= 0 && index !== at) {
                setDraft(moveSection(draft, at, index));
            }
        };
        const tick = () => {
            frame = requestAnimationFrame(() => {
                const area = scroller?.getBoundingClientRect();
                const step = area == null ? 0 : autoScrollStep(last.y, area.top, area.bottom);
                if (step !== 0) {
                    scroller.scrollTop += step;
                    follow();
                }
                tick();
            });
        };
        const begin = () => {
            begun = true;
            document.dispatchEvent(new Event(CloseTipsEvent));
            const show = () => {
                o().onZone({ active: id === "usage", over: false });
                setDragging(id);
            };
            // The zone takes room in the main agent's block: it is there before the block is placed under the pointer.
            // A block picked up by a long press begins in a layout effect, where nothing can be flushed.
            if (carried) {
                show();
            } else {
                flushSync(show);
            }
            o().announce(tRef.current("companion.arrange.picked", { name: o().nameOf(id) }));
            tick();
            follow();
        };
        followRef.current = follow;
        const release = () => {
            followRef.current = null;
            cancelAnimationFrame(frame);
            listeners.forEach(([type, fn, capture]) => window.removeEventListener(type, fn, capture));
            listeners.length = 0;
            stop.current = null;
        };
        const finish = (drop: boolean) => {
            release();
            if (!begun) {
                return;
            }
            // The click that ends a drag is not a click on whatever is under the pointer.
            const eat = (ev: Event) => {
                ev.stopPropagation();
                ev.preventDefault();
            };
            window.addEventListener("click", eat, true);
            setTimeout(() => window.removeEventListener("click", eat, true), 0);
            const name = o().nameOf(id);
            if (!drop) {
                setDraft(snapshot);
                o().announce(tRef.current("companion.arrange.putBack", { name }));
            } else {
                const draft = o().draftRef.current;
                const attached = draft.find((p) => p.id === id)?.attached === true;
                const index = draft.findIndex((p) => p.id === id);
                if (over && id === "usage") {
                    setDraft(dropSection(draft, id, { to: "attach" }));
                    o().announce(tRef.current("companion.arrange.attachOn", { name }));
                } else {
                    setDraft(dropSection(draft, id, { to: "list", index }));
                    o().announce(
                        attached && id === "usage"
                            ? tRef.current("companion.arrange.attachOff", { name })
                            : tRef.current("companion.arrange.moved", {
                                  name,
                                  position: index + 1,
                                  total: draft.length,
                              })
                    );
                }
            }
            setDragging(null);
            o().onZone({ active: false, over: false });
        };
        const watch = (type: string, fn: (ev: any) => void, capture?: boolean) => {
            listeners.push([type, fn, capture]);
            window.addEventListener(type, fn, capture);
        };
        watch("pointermove", (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) {
                return;
            }
            // A button released out of the window never came: nothing is carried that no hand holds.
            if (ev.pointerType === "mouse" && ev.buttons === 0) {
                finish(true);
                return;
            }
            last = { x: ev.clientX, y: ev.clientY };
            if (!begun && passedDragStart(from, last)) {
                begin();
                return;
            }
            if (begun) {
                follow();
            }
        });
        watch("pointerup", (ev: PointerEvent) => ev.pointerId === pointerId && finish(true));
        watch("pointercancel", (ev: PointerEvent) => ev.pointerId === pointerId && finish(false));
        watch(
            "keydown",
            (ev: KeyboardEvent) => {
                if (ev.key === "Escape" && begun) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    finish(false);
                }
            },
            true
        );
        stop.current = release;
        if (carried) {
            begin();
        }
    }, []);

    // A block picked up by a long press: the mode has just mounted, the pointer is still down.
    useLayoutEffect(() => {
        const { pickup, flowRef, onPickupDone } = latest.current;
        if (pickup == null) {
            return;
        }
        onPickupDone();
        const el = flowRef.current?.querySelector<HTMLElement>(`:scope > [data-flow-id="${pickup.id}"]`);
        if (el == null || pickup.released) {
            return;
        }
        const grab = { x: Math.min(pickup.grab.x, Math.max(0, el.offsetWidth - 12)), y: pickup.grab.y };
        arm(pickup.id, pickup.pointerId, { x: pickup.x, y: pickup.y }, grab, true);
    }, []);

    const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
        const target = e.target as Element;
        const block = target.closest<HTMLElement>("[data-flow-id]");
        const id = block?.dataset.flowId;
        if (block == null || !SectionIdSet.has(id) || !startsPress(e.nativeEvent)) {
            return;
        }
        // Anything of the block holds it but its own controls, which keep their click.
        const control =
            "button:not([data-arrange='handle']), a, input, select, textarea, fieldset, [role='radiogroup']";
        if (target.closest(control) != null) {
            return;
        }
        const box = block.getBoundingClientRect();
        arm(
            id as CompanionSectionId,
            e.pointerId,
            { x: e.clientX, y: e.clientY },
            { x: e.clientX - box.left, y: e.clientY - box.top },
            false
        );
    };
    return { dragging, onPointerDown };
}

// The arranging mode in place (#2395, #2441, #2459): every block folds to its label and one line, with its rank, Up and
// Down (the arrows, Home and End on its handle), full width or fluid, and the eye, and is carried by its header to
// the rank it is dropped at. The changes are drafted here and saved when the mode is left, however it is left (Done,
// Escape, a click on the ground, the Arrange tool, the pane closing).
function ArrangingFlow(
    props: CompanionDashboardProps & {
        cols: Columns;
        onColumns: (cols: Columns) => void;
        pickup: Pickup;
        onPickupDone: () => void;
        zoneRef: React.RefObject<HTMLDivElement>;
        onZone: (zone: Partial<ZoneState>) => void;
    }
) {
    const { layout, onSaveLayout, onLeaveArranging, view, agentState, provider } = props;
    const t = useT();
    const flowRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const [draft, setDraft] = useState<CompanionLayout>(() => normalizeLayout(layout));
    const [note, setNote] = useState("");
    const announced = useRef(false);
    const focusAfter = useRef<{ id: CompanionSectionId; what: string }>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const saveRef = useRef(onSaveLayout);
    saveRef.current = onSaveLayout;
    const committer = useRef<(draft: CompanionLayout) => boolean>(null);
    committer.current ??= makeLayoutCommit(draft, (next) => saveRef.current(next));
    const sums = useSummaries(view, agentState, provider);
    useEffect(() => {
        titleRef.current?.focus({ preventScroll: true });
        return () => {
            committer.current(draftRef.current);
        };
    }, []);
    useLayoutEffect(() => {
        const after = focusAfter.current;
        if (after == null) {
            return;
        }
        focusAfter.current = null;
        flowRef.current
            ?.querySelector<HTMLElement>(`[data-flow-id="${after.id}"] [data-arrange="${after.what}"]`)
            ?.focus();
    }, [draft]);
    const leave = () => {
        committer.current(draftRef.current);
        onLeaveArranging();
    };
    const announce = (text: string) => {
        announced.current = !announced.current;
        setNote(announced.current ? `${text}${InvisibleMark}` : text);
    };
    const nameOf = (id: CompanionSectionId) => t(SectionNameKeys[id]);
    const drag = useBlockDrag({
        flowRef,
        zoneRef: props.zoneRef,
        draftRef,
        setDraft,
        onZone: props.onZone,
        announce,
        nameOf,
        pickup: props.pickup,
        onPickupDone: props.onPickupDone,
    });
    const draftUsage = usageOf(draft);
    const { onZone } = props;
    useEffect(() => {
        onZone({ shown: draftUsage.shown, attached: draftUsage.attached });
    }, [onZone, draftUsage.shown, draftUsage.attached]);
    const move = (id: CompanionSectionId, to: number, what: string) => {
        const from = draft.findIndex((p) => p.id === id);
        const target = Math.max(0, Math.min(draft.length - 1, to));
        if (target === from) {
            announce(t(from === 0 ? "companion.arrange.first" : "companion.arrange.last", { name: nameOf(id) }));
            return;
        }
        const next = moveSection(draft, from, target);
        focusAfter.current = { id, what };
        setDraft(next);
        announce(t("companion.arrange.moved", { name: nameOf(id), position: target + 1, total: next.length }));
    };
    const isDefault = isDefaultLayout(draft);
    const items: FlowItem[] = draft.map((p) => ({ id: p.id, full: p.span === "full" }));
    const { prefs, set: setPref } = useBlockPrefs();
    // The Taken by others group opens by itself while the milestone block is wide (#2418): so it reads in its option.
    const tasksWidth =
        props.cols.columns >= 2 && draft.find((p) => p.id === "tasks")?.span === "full" ? 0 : props.cols.columnWidth;
    const prefDefaults: PrefDefaults = { takenopen: !(tasksWidth > 0 && tasksWidth < CompactBlockPx) };
    const optionOf = (id: CompanionSectionId, key: BlockOptionKey) => optionsOf(id).find((o) => o.key === key);
    // An option set, from the block's own buttons or its settings: a layout option is drafted with the layout, a
    // preference is saved as it is set; both are announced.
    const change = (id: CompanionSectionId, option: BlockOption, value: boolean) => {
        const name = nameOf(id);
        if (option.store === "layout") {
            setDraft(setLayoutOption(draft, id, option, value));
            announce(t(optionAnnouncement(option, value), { name }));
            return;
        }
        setPref(option.key as BlockPrefKey, value);
        announce(t(optionAnnouncement(option, value), { name, option: t(option.labelKey) }));
    };
    return (
        <>
            <CompanionBlock
                className="mt-cdash-arrbar"
                label={
                    <span ref={titleRef} tabIndex={-1} className="outline-none">
                        {t("companion.arrange.title")}
                    </span>
                }
                icon={<i className="fa fa-solid fa-table-columns" aria-hidden="true" />}
                data-testid="companion-arrange"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        leave();
                    }
                }}
            >
                <div className="mt-cdash-arrbar-in">
                    <p>{t("companion.arrange.hint")}</p>
                    <div className="mt-cdash-arrbar-actions">
                        <button
                            type="button"
                            className="molten-btn-ghost inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 border border-border px-3 text-12 aria-disabled:cursor-default aria-disabled:opacity-40"
                            aria-disabled={isDefault}
                            onClick={() => {
                                if (isDefault) {
                                    return;
                                }
                                setDraft(resetLayout());
                                announce(t("companion.arrange.resetDone"));
                            }}
                            data-testid="companion-arrange-reset"
                        >
                            {t("companion.arrange.reset")}
                        </button>
                        <button
                            type="button"
                            className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 px-3 text-12 font-medium"
                            onClick={leave}
                            data-testid="companion-arrange-done"
                        >
                            {t("companion.arrange.done")}
                            <MoltenWave />
                        </button>
                    </div>
                </div>
            </CompanionBlock>
            <div
                className="contents"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        leave();
                    }
                }}
            >
                <Flow
                    items={items}
                    arranging={true}
                    dragging={drag.dragging}
                    flowProps={{ onPointerDown: drag.onPointerDown }}
                    onColumns={props.onColumns}
                    flowRef={flowRef}
                >
                    {draft.map((p, i) => {
                        const name = nameOf(p.id);
                        const shown = !p.hidden;
                        const full = p.span === "full";
                        const { position, total } = positionOf(draft, p.id);
                        const sum =
                            p.id === "usage" && !sums.usage.absent ? { text: t(usageSummaryKey(p)) } : sums[p.id];
                        return (
                            <CompanionBlock
                                key={p.id}
                                flowId={p.id}
                                label={name}
                                icon={SectionTiles[p.id]}
                                tone={p.id === "permission" ? "waiting" : undefined}
                                data-hidden={shown ? undefined : ""}
                                data-dragging={drag.dragging === p.id ? "" : undefined}
                                data-absent={sum.absent ? "" : undefined}
                                data-testid="companion-arrange-row"
                                data-section={p.id}
                                data-span={p.span}
                                grip={
                                    <button
                                        type="button"
                                        className="mt-cb-grip"
                                        data-arrange="handle"
                                        aria-label={t("companion.arrange.handleAt", { name, position, total })}
                                        data-tip={t("companion.arrange.handleHelp")}
                                        onKeyDown={(e) => {
                                            const to = handleTarget(e.key, i, draft.length);
                                            if (to == null) {
                                                return;
                                            }
                                            e.preventDefault();
                                            move(p.id, to, "handle");
                                        }}
                                        data-testid="companion-arrange-handle"
                                    >
                                        <i className="fa-solid fa-ellipsis" aria-hidden="true" />
                                    </button>
                                }
                                chips={
                                    shown ? null : (
                                        <span className="mt-cb-chip mt-cb-chip-off">
                                            {t("companion.arrange.hidden")}
                                        </span>
                                    )
                                }
                                tools={
                                    <>
                                        <BlockTool
                                            label={t("companion.arrange.show", { name })}
                                            pressed={shown}
                                            marker="show"
                                            onClick={() => change(p.id, optionOf(p.id, "shown"), !shown)}
                                            testId="companion-arrange-switch"
                                        >
                                            <i
                                                className={shown ? "fa fa-solid fa-eye" : "fa fa-solid fa-eye-slash"}
                                                aria-hidden="true"
                                            />
                                        </BlockTool>
                                        <BlockTool
                                            label={t("companion.arrange.wide", { name })}
                                            pressed={full}
                                            marker="wide"
                                            onClick={() => change(p.id, optionOf(p.id, "wide"), !full)}
                                            testId="companion-arrange-wide"
                                        >
                                            <i className="fa fa-solid fa-arrows-left-right" aria-hidden="true" />
                                        </BlockTool>
                                        <BlockSettings
                                            id={p.id}
                                            name={name}
                                            placement={p}
                                            prefs={prefs}
                                            defaults={prefDefaults}
                                            onChange={(option, value) => change(p.id, option, value)}
                                        />
                                    </>
                                }
                            >
                                <div className="mt-cb-sum" data-tip={sum.text}>
                                    {sum.text}
                                </div>
                            </CompanionBlock>
                        );
                    })}
                </Flow>
            </div>
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="companion-arrange-note"
            >
                {note}
            </div>
        </>
    );
}
