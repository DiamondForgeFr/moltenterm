// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's floating group (FR-BOSS-009, AC17 to AC21, #2032): what opens from his title-bar face. It floats over the
// interface (no modal, no backdrop, nothing moves under it) and replaces the panel of #2003: his square, with the screen
// effect and his name; one rail of five round icons against it; under it one block (a line from him, then the weekly usage
// per provider) and the field to write to him; and beside the rail one panel at a time, chosen by priority when the group
// opens, previewed by hover, pinned by a click. It closes with Escape, a click outside, the face again or the square;
// opened by hovering the face, it closes by itself once the pointer has left both until the developer pins it (#2103). The
// geometry and the rules of which panel shows are brokk-group-model.ts's; the rows of each panel are the models that
// already hold the facts (brokk-notes-model.ts, brokk-rows-model.ts, brokk-usage-model.ts).
//
// His square is his living portrait, not a plain video: it takes the pose and the mood the #2003 panel took
// (use-brokk-live.ts useCardLive: listening while the developer writes, thinking, speaking, the severity gestures, the
// expression queue, the blink rhythm, #2025's waiting), and the line under it is his own answer or a moment of a kind
// colleague (brokk-colleague.ts), else nothing (#2203).
//
// During a brainstorm the group takes the brainstorm layout (FR-BOSS-010 AC23, #2285, brainstormLayout): the rail and
// the block give way to the brainstorm panel beside the square, and the talk window under both is wide and open.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import {
    CSSProperties,
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { AgentStates } from "../agent-state-store";
import { AiIcon } from "../ai-icon";
import { BrainstormStateAtom } from "../brainstorm/brainstorm-boot";
import { agentName } from "../companion/companion-task-model";
import { isActive, overallDownloadProgress } from "../downloads/downloads-model";
import { DownloadsModel } from "../downloads/downloads-store";
import { useLocale, useT } from "../i18n/i18n";
import { CupIcon } from "../keepawake-cup-icon";
import { keepAwakeActive } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { modalIsOpen } from "../modal-open";
import { MoltentermNotifications } from "../notifications-store";
import { TabActivity, whileShown } from "../tab-activity";
import { Tether } from "../tether/tether";
import { RopePx, tetherLine } from "../tether/tether-model";
import { UsageWeekGrid, UsageWeekRow } from "../usage-week/usage-week";
import { loadWorkspaceSources } from "../workspace-rail";
import { AnchorAttr, cardKeyAction, CardKeyInput, CardTestId, isOutsidePress } from "./boss-card-model";
import { attentionAgents } from "./boss-overview";
import { BossPortrait } from "./boss-portrait";
import { BossBubbleModel } from "./boss-store";
import { UsageReadingsAtom, UsageUnreadableAtom } from "./boss-usage";
import { BrokkItem, sayLine } from "./brokk-exchange-model";
import {
    activePanel,
    afterClick,
    afterClose,
    afterHover,
    afterRequest,
    arrivalOffset,
    ArrivalStepMs,
    autoPanelIn,
    brainstormLayout,
    brainstormPanel,
    closesCardIn,
    ConversationChromePx,
    conversationHeight,
    conversationWidth,
    EmptyReportSize,
    groupFlow,
    groupGeometry,
    groupOpeningPanel,
    GroupPlace,
    holdsHover,
    HoverIntent,
    InitialPanels,
    neighbourPanel,
    panelHeight,
    PanelId,
    panelRoom,
    PanelState,
    panelWidth,
    plinkLine,
    priorityFactsOf,
    RailInput,
    RailMark,
    railMarks,
    RailPanels,
    Rect,
    ReportLines,
    ReportSize,
    ReportView,
    reportView,
    SquarePx,
    TilePx,
    typingTarget,
} from "./brokk-group-model";
import "./brokk-group.css";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkKeepAwakePanel } from "./brokk-keepawake-panel";
import { brokkMenuItems } from "./brokk-menu";
import { buildNotes, consultedIds, noteFacts, NoteRow } from "./brokk-notes-model";
import { NotificationsPanel } from "./brokk-notes-panel";
import { PanelContentAttr, PanelHeadAttr } from "./brokk-panel-frame";
import { AgentsPanel, DownloadsPanel, SessionsPanel } from "./brokk-rows-panels";
import { BrokkSession } from "./brokk-session";
import { BrokkTalk } from "./brokk-talk";
import { talkWaits } from "./brokk-talk-model";
import { WeeklyUsage, weeklyUsage } from "./brokk-usage-model";
import { useBrokkActions } from "./use-brokk-actions";
import { useAvatarKeys } from "./use-brokk-hub";
import { useCardLive } from "./use-brokk-live";
import { useBrokkMoment } from "./use-brokk-moment";
import { useTalkFace } from "./use-brokk-talk-face";

// How often "up 12 min" and the ages are read again while the group shows.
const AgeTickMs = 15000;

// The brainstorm panel (FR-BOSS-010 AC23, #2285) loads with the brainstorm, the first time the mode opens: the group
// draws its frame at once.
const BrainstormPanel = lazy(() =>
    import("../brainstorm/brainstorm-panel").then((mod) => ({ default: mod.BrainstormPanel }))
);

// A provider's row in the shared week grid, named with its agent's display name.
function weekRow(u: WeeklyUsage): UsageWeekRow {
    const { provider, readAt, old, unreadable, ...line } = u;
    return {
        key: provider,
        agent: provider,
        name: agentName(provider),
        line: unreadable ? undefined : line,
        unreadable,
        readAt,
        old,
    };
}

// When the developer last looked at the Téléchargements panel: a download that failed or finished since is news, until he
// looks (FR-BOSS-009, AC18). It lasts for a run of MoltenTerm.
let downloadsLookedAt = 0;

// The last panel the developer chose (a click, a request, a close that switched): the group opens on it next time when
// the priority has nothing to say (#2090). It lasts for a run of MoltenTerm.
let rememberedPanel: PanelId = null;

export function rememberPanel(id: PanelId): void {
    rememberedPanel = id;
}

const RailIcons: Record<PanelId, string> = {
    notifications: "bell",
    agents: AiIcon,
    sessions: "terminal",
    downloads: "download",
    keepawake: "mug-hot",
};

// Where the group stands in the host's layer, and where the title-bar face is, so that the group arrives from it.
export type GroupFrame = {
    place: GroupPlace;
    // The middle of the face, in the layer's coordinates; null when no face is on screen (Brokk turned off).
    origin: { x: number; y: number };
    // The ember thread from the face to the square: its left, its top and its width in the layer's coordinates.
    thread: { x: number; y: number; w: number };
};

function focusIsAtHome(root: HTMLElement): boolean {
    const active = document.activeElement;
    return (
        active == null || active === document.body || root.contains(active) || active.closest(`[${AnchorAttr}]`) != null
    );
}

function RailMarkView({ mark }: { mark: RailMark }) {
    const circ = 2 * Math.PI * 19;
    return (
        <>
            {mark.ring != null ? (
                <svg className="mt-brokk-ring-progress" viewBox="0 0 40 40" aria-hidden data-testid="brokk-rail-ring">
                    <circle
                        cx="20"
                        cy="20"
                        r="19"
                        strokeDasharray={mark.ring >= 0 ? `${circ * mark.ring} ${circ}` : `${circ * 0.25} ${circ}`}
                    />
                </svg>
            ) : null}
            {mark.count > 0 ? (
                <span
                    className="mt-brokk-cnt"
                    data-grave={mark.grave ? "true" : undefined}
                    data-testid="brokk-rail-count"
                >
                    {mark.count > 9 ? "9+" : mark.count}
                </span>
            ) : null}
            {mark.dot ? <span className="mt-brokk-dot" aria-hidden data-testid="brokk-rail-dot" /> : null}
        </>
    );
}

// Keep awake says "on" with the cup itself, orange with rising steam, never with a dot: a dot on the rail means
// something to look at (FR-BOSS-009 AC80, #2206).
function RailIcon({ id, mark }: { id: PanelId; mark: RailMark }) {
    if (id === "keepawake") {
        return <CupIcon on={mark.ember} tone="action" steam="rise" />;
    }
    return <i className={makeIconClass(RailIcons[id], true)} aria-hidden />;
}

// The light scrim over the work area while the group is open (FR-BOSS-009, AC39, #2082). It fills the host's layer, which
// is the work area right of the sidebar, so the sidebar stays undimmed. A press on it is a press outside (the group's own
// listener closes it); the click closes it too, for a press that listener did not see.
export function BrokkScrim({ shown, onClose }: { shown: boolean; onClose: () => void }) {
    return (
        <div
            className={cn("mt-brokk-scrim", shown && "is-in")}
            aria-hidden
            data-testid="brokk-scrim"
            onClick={onClose}
        />
    );
}

// The card under the square, Brokk's report, as it shows (#2090, #2097): two lines at rest. When the report needs more,
// the card takes the keyboard focus, and pointing at it or focusing it makes the card itself taller, in the group's
// flow, to hold the whole report (reportView): nothing is laid over anything, and what stands under the card moves down
// with it. A report that fits changes nothing.
export function SayCard({
    line,
    source,
    view,
    textRef,
    onHover,
    onFocusVisible,
}: {
    line: string;
    source: string;
    view: ReportView;
    textRef?: React.Ref<HTMLSpanElement>;
    onHover?: (hovered: boolean) => void;
    onFocusVisible?: (focused: boolean) => void;
}) {
    return (
        <div
            className="mt-brokk-say"
            data-testid="brokk-say"
            data-source={source}
            data-cut={view.cut ? "true" : undefined}
            data-open={view.open ? "true" : undefined}
            role={view.cut ? "note" : undefined}
            tabIndex={view.cut ? 0 : undefined}
            onPointerEnter={() => onHover?.(true)}
            onPointerLeave={() => onHover?.(false)}
            // A click focuses the card too, and must not keep it open once the pointer is gone: only the keyboard does.
            onFocus={(e) => onFocusVisible?.(e.currentTarget.matches(":focus-visible"))}
            onBlur={() => onFocusVisible?.(false)}
        >
            <span ref={textRef} style={view.textHeight != null ? { height: view.textHeight } : undefined}>
                {line}
            </span>
        </div>
    );
}

// What the text measures is read from the text itself: the height it needs (scrollHeight, the whole of it whether the
// card clamps it or has grown to it) and the height of the lines the card keeps. Neither is the box's current height, so
// they stay the same while the card grows and folds.
function reportSizeOf(text: HTMLElement): ReportSize {
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    return {
        full: text.scrollHeight,
        shown: Number.isFinite(lineHeight) ? Math.round(lineHeight * ReportLines) : text.clientHeight,
    };
}

function BrokkSay({
    line,
    source,
    view,
    onSize,
    onHover,
    onFocusVisible,
}: {
    line: string;
    source: string;
    view: ReportView;
    onSize: (size: ReportSize) => void;
    onHover: (hovered: boolean) => void;
    onFocusVisible: (focused: boolean) => void;
}) {
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const text = ref.current;
        if (text == null) {
            return;
        }
        const measure = () => onSize(reportSizeOf(text));
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(text);
        return () => observer.disconnect();
    }, [line, onSize]);
    return (
        <SayCard
            line={line}
            source={source}
            view={view}
            textRef={ref}
            onHover={onHover}
            onFocusVisible={onFocusVisible}
        />
    );
}

export function BrokkGroup({ frame, shown }: { frame: GroupFrame; shown: boolean }) {
    const t = useT();
    const locale = useLocale();
    const boss = BossBubbleModel.getInstance();
    const hubModel = BrokkHubModel.getInstance();
    const notifications = MoltentermNotifications.getInstance();
    const downloads = DownloadsModel.getInstance();
    const name = useAtomValue(boss.nameAtom, { store: globalStore });
    const request = useAtomValue(boss.tabRequestAtom, { store: globalStore });
    const pinned = useAtomValue(boss.cardPinnedAtom, { store: globalStore });
    const toHandle = useAtomValue(boss.toHandleAtom, { store: globalStore });
    const entries = useAtomValue(notifications.shownEntriesAtom, { store: globalStore });
    const settings = useAtomValue(hubModel.settingsAtom, { store: globalStore });
    const answering = useAtomValue(hubModel.ownWorkingAtom, { store: globalStore });
    const session = BrokkSession.getInstance();
    const talk = useAtomValue(session.stateAtom, { store: globalStore });
    const exchange = useAtomValue(session.exchangeAtom, { store: globalStore });
    const unseenId = useAtomValue(session.unseenIdAtom, { store: globalStore });
    const agentStates = useAtomValue(AgentStates.getInstance().dataAtom, { store: globalStore });
    const downloadItems = useAtomValue(downloads.itemsAtom, { store: globalStore });
    const running = useAtomValue(downloads.ringAtom, { store: globalStore });
    const transfers = useAtomValue(downloads.transfersAtom, { store: globalStore });
    const badgeKeys = useAvatarKeys();
    const readings = useAtomValue(UsageReadingsAtom, { store: globalStore });
    const unreadable = useAtomValue(UsageUnreadableAtom, { store: globalStore });
    const keepState = useAtomValue(KeepAwakeModel.getInstance().stateAtom, { store: globalStore });
    const currentWorkspace = useAtomValue(atoms.workspace, { store: globalStore });
    // The brainstorm takes the screen (FR-BOSS-010, #2257): his group takes the brainstorm layout (AC23, #2285), with his
    // portrait, the brainstorm panel in the rail's place and his wide talk window under both, and the graph in the space
    // beside. No rail panel shows (the notifications are held), and only Escape or the panel's Leave button ends it,
    // never a click outside.
    const brainstorming = useAtomValue(BrainstormStateAtom, { store: globalStore })?.open === true;
    const brainstormingRef = useRef(brainstorming);
    brainstormingRef.current = brainstorming;
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [now, setNow] = useState(Date.now());
    const [typing, setTyping] = useState(false);
    // The conversation window is open while the field has the focus or holds text: the panel then gives way above it (the
    // windows never overlap, AC18, #2090). `exchangeHeight` is what the exchange in it needs.
    const [conversation, setConversation] = useState(false);
    const [exchangeHeight, setExchangeHeight] = useState(0);
    const [panels, setPanels] = useState<PanelState>(() =>
        request != null ? afterRequest(request.tab) : InitialPanels
    );
    const [highlight, setHighlight] = useState<string[]>(() => request?.highlight ?? []);
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const [lookedAt, setLookedAt] = useState(downloadsLookedAt);
    const [height, setHeight] = useState(SquarePx);
    // Brokk's report under the square (AC43, #2097): what its text measures, and whether the developer points at it
    // (the pointer over it, or the keyboard on it). The card grows while he does, and what is under it moves down.
    const [reportSize, setReportSize] = useState<ReportSize>({ full: 0, shown: 0 });
    const [reportHovered, setReportHovered] = useState(false);
    const [reportFocused, setReportFocused] = useState(false);
    // The usage grid's height, measured: the card under the square is as tall as its rows, and the field and the
    // layout under it follow (AC57, #2106). The card is not drawn during a brainstorm (#2285): the grid is measured
    // again when the mode ends.
    const usageRef = useRef<HTMLDivElement>(null);
    const [usageHeight, setUsageHeight] = useState(0);
    useLayoutEffect(() => {
        const usage = usageRef.current;
        if (usage == null) {
            return;
        }
        const measure = () => setUsageHeight(usage.offsetHeight);
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(usage);
        return () => observer.disconnect();
    }, [brainstorming]);
    // His line under the square is his own when his session has something the developer has not seen (AC25), else the
    // moment of a kind colleague (AC72), else nothing: the line is hidden and the card holds the usage grid alone (AC71).
    const unseen = exchange.find((item) => item.role === "brokk" && item.id === unseenId) as BrokkItem;
    const answerHoldsLine = sayLine(unseen, "") !== "";
    const moment = useBrokkMoment(shown && !answerHoldsLine);
    const line = sayLine(unseen, moment?.text ?? "");
    const hasLine = line !== "";
    const g = useMemo(() => groupGeometry(SquarePx, TilePx, usageHeight, hasLine), [usageHeight, hasLine]);
    const bs = brainstorming ? brainstormLayout(g, frame.place) : null;
    const report = reportView(
        g,
        hasLine ? reportSize : EmptyReportSize,
        reportHovered || reportFocused,
        frame.place.heightRoom
    );
    const flow = groupFlow(g, report.growth);
    const onReportSize = useCallback(
        (next: ReportSize) =>
            setReportSize((prev) => (prev.full === next.full && prev.shown === next.shown ? prev : next)),
        []
    );
    useEffect(() => {
        if (!report.cut) {
            setReportFocused(false);
        }
    }, [report.cut]);

    const rows = useMemo(
        () => buildNotes({ toHandle, entries, settings, now }),
        // The words of a row follow the language, and a wait turns grave with time.
        [toHandle, entries, settings, now, locale]
    );
    const facts = noteFacts(rows);
    const agentBlocked = attentionAgents(agentStates).length > 0;
    const downloadReported = downloadItems.some(
        (r) => !isActive(r) && (r.state === "completed" || r.state === "interrupted") && r.endedAt > lookedAt
    );
    const keepAwake = keepAwakeActive(keepState);
    const railInput: RailInput = {
        badgeKeys,
        urgentOrAnswer: facts.urgentOrAnswer,
        unread: facts.unread,
        agentBlocked,
        downloadReported,
        downloadProgress: overallDownloadProgress(running),
        downloadRunning: running.length > 0,
        keepAwake,
    };
    // The panel the group opens with is read once, when it opens: nothing changes under the developer's eyes after.
    const [auto] = useState<PanelId>(() => groupOpeningPanel(priorityFactsOf(railInput), rememberedPanel));
    useEffect(() => {
        if (brainstorming) {
            setPanels(InitialPanels);
        }
    }, [brainstorming]);
    const active: PanelId = brainstormPanel(activePanel(panels, autoPanelIn(auto, brainstorming)), brainstorming);
    useEffect(() => {
        if (panels.pinned != null) {
            rememberPanel(panels.pinned);
        }
    }, [panels.pinned]);
    const marks = railMarks(railInput);
    const weekly = useMemo(() => weeklyUsage(readings, now, unreadable), [readings, now, unreadable]);
    const weekRows = useMemo(() => weekly.map(weekRow), [weekly]);

    // What his face does with the conversation: it listens while the developer writes, thinks only when his answer is
    // slow to come, speaks while it is revealed (AC86, AC87, #2259).
    const pose = useTalkFace({ typing, awaiting: talkWaits(talk), working: answering });
    const live = useCardLive(pose);
    // The sign of a conversation on the title-bar face: the developer writes to him or his session answers.
    useEffect(() => {
        globalStore.set(boss.talkingAtom, pose != null);
    }, [boss, pose]);
    useEffect(() => () => globalStore.set(boss.talkingAtom, false), [boss]);

    const leave = useCallback(() => boss.closeCard({ restoreFocus: false }), [boss]);
    const actions = useBrokkActions(leave);
    const rowsRef = useRef<NoteRow[]>(rows);
    rowsRef.current = rows;
    const listedRef = useRef(new Set<string>());
    const notesShownRef = useRef(false);
    const onListed = useCallback((ids: string[]) => {
        notesShownRef.current = true;
        ids.forEach((id) => listedRef.current.add(id));
    }, []);
    const onFocusChange = useCallback((open: boolean) => setConversation(open), []);
    // The window is as wide as the group and the panel area together, as tall as the exchange needs, from the field's top
    // wherever the grown report card has pushed it (it gives way when the window's room runs out). During a brainstorm
    // it is the layout's, wide and as tall as the window allows from the start (AC23, #2285).
    const fieldTop = bs != null ? bs.talk.y : flow.field.y;
    const fieldSize =
        bs != null
            ? { w: bs.talk.w, h: bs.talk.h }
            : conversation
              ? {
                    w: conversationWidth(g, frame.place.panelRoom),
                    h: conversationHeight(exchangeHeight + ConversationChromePx, frame.place.heightRoom - flow.field.y),
                }
              : { w: g.field.w, h: g.field.h };

    // A surface asks for a panel while the group is open (a toast's Open, the downloads pill, a notification).
    const seenRequest = useRef(request?.seq ?? 0);
    useEffect(() => {
        if (request == null || request.seq === seenRequest.current) {
            return;
        }
        seenRequest.current = request.seq;
        setPanels(afterRequest(request.tab));
        setHighlight(request.highlight);
    }, [request]);

    // The developer asked for the group, so the focus comes into it. A group the hover of the face opened takes none, so
    // that typing still goes where it went, until the developer pins it (FR-BOSS-009, AC53, AC55, #2103).
    useEffect(() => {
        const root = rootRef.current;
        if (!pinned || root == null || root.contains(document.activeElement)) {
            return;
        }
        root.focus({ preventScroll: true });
    }, [pinned]);
    // Any interaction pins it: a press or the focus inside (typing in the field, the rail's arrows), a panel opened by a
    // click (AC54). The pointer tells the face's hover where it is, so that leaving both closes an unpinned group.
    const faceHover = hubModel.faceHover;
    const pin = useCallback(() => boss.pinCard(), [boss]);
    useEffect(() => () => faceHover.groupGone(), [faceHover]);
    useEffect(() => TabActivity.getInstance().every(whileShown(AgeTickMs), () => setNow(Date.now()), "clock"), []);
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            const sources = await loadWorkspaceSources();
            if (!live) {
                return;
            }
            const known = new Map(sources.map((s) => [s.workspace.oid, s.workspace]));
            if (currentWorkspace != null && !known.has(currentWorkspace.oid)) {
                known.set(currentWorkspace.oid, currentWorkspace);
            }
            setWorkspaces(known);
        });
        return () => {
            live = false;
        };
    }, [currentWorkspace]);
    useEffect(() => {
        if (active === "downloads") {
            downloadsLookedAt = Date.now();
            setLookedAt(downloadsLookedAt);
        }
    }, [active]);

    // What the developer saw when Brokk closes: the Info notifications he consulted go to the archive (AC19), and what he
    // looked at in the list is read, as the bell's panel did on closing.
    useEffect(
        () => () => {
            if (!notesShownRef.current) {
                return;
            }
            notifications.settleSeen();
            const ids = consultedIds(rowsRef.current, listedRef.current);
            if (ids.length > 0) {
                fireAndForget(() => notifications.handle(ids));
            }
        },
        [notifications]
    );

    // The panel's height: the square's by default, what its content needs past it, up to the window, then it scrolls.
    // While the conversation window is open, only up to its top (#2090).
    const panelW = panelWidth(frame.place.panelRoom);
    const heightRoom = panelRoom(g, frame.place.heightRoom, conversation);
    const panelRect = useRef<Rect>({ x: g.panelLeft, y: 0, w: panelW, h: 0 });
    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (active == null || panel == null) {
            panelRect.current = { x: g.panelLeft, y: 0, w: panelW, h: 0 };
            return;
        }
        const measure = () => {
            const head = panel.querySelector<HTMLElement>(`[${PanelHeadAttr}]`)?.offsetHeight ?? 0;
            const content = panel.querySelector<HTMLElement>(`[${PanelContentAttr}]`)?.offsetHeight ?? 0;
            const next = panelHeight(head + content + 16, heightRoom, Math.min(g.square, heightRoom));
            setHeight(next);
            panelRect.current = { x: g.panelLeft, y: 0, w: panelW, h: next };
        };
        measure();
        const content = panel.querySelector<HTMLElement>(`[${PanelContentAttr}]`);
        if (content == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(content);
        return () => observer.disconnect();
    }, [active, panelW, heightRoom, g, rows.length]);

    // Hover: the zone decides, 80 ms to open and 250 ms to close (brokk-group-model.ts HoverIntent). There is no rail
    // during a brainstorm (#2285): nothing previews, and no sheet catches the pointer over the graph.
    useEffect(() => {
        if (!shown || brainstorming) {
            return;
        }
        const intent = new HoverIntent({
            geometry: () => g,
            panel: () => panelRect.current,
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            onHover: (id) => setPanels((state) => afterHover(state, id)),
        });
        const onMove = (e: PointerEvent) => {
            const root = rootRef.current;
            if (root == null || e.pointerType === "touch") {
                return;
            }
            const box = root.getBoundingClientRect();
            intent.move(e.clientX - box.left, e.clientY - box.top);
        };
        const onLeave = () => intent.leave();
        document.addEventListener("pointermove", onMove);
        document.documentElement.addEventListener("pointerleave", onLeave);
        return () => {
            document.removeEventListener("pointermove", onMove);
            document.documentElement.removeEventListener("pointerleave", onLeave);
            intent.stop();
        };
    }, [shown, g, brainstorming]);

    // Escape and a press outside close it; a press on the face is the face's own toggle.
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (ContextMenuModel.getInstance().session != null) {
                return;
            }
            if (
                isOutsidePress(e.target as Element, rootRef.current) &&
                closesCardIn(brainstormingRef.current, "outside")
            ) {
                boss.closeCard();
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            const root = rootRef.current;
            if (
                root == null ||
                e.isComposing ||
                modalIsOpen() ||
                modalsModel.hasOpenModals() ||
                ContextMenuModel.getInstance().session != null
            ) {
                return;
            }
            const input: CardKeyInput = { key: e.key, focusAtHome: focusIsAtHome(root) };
            const action = cardKeyAction(input);
            if (
                !action.hide ||
                !closesCardIn(brainstormingRef.current, "escape", typingTarget(document.activeElement))
            ) {
                return;
            }
            if (action.consume) {
                e.preventDefault();
                e.stopPropagation();
            }
            boss.closeCard();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [boss]);

    const closePanel = () => setPanels(afterClose(active, auto));
    const clickIcon = (id: PanelId) => setPanels(afterClick(id));
    const onRailKeyDown = (e: React.KeyboardEvent, id: PanelId) => {
        const next = neighbourPanel(id, e.key);
        if (next == null) {
            return;
        }
        e.preventDefault();
        setPanels(afterRequest(next));
        rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${next}"]`)?.focus();
    };
    const showMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuModel.getInstance().showContextMenu(brokkMenuItems(name, leave), e);
    };

    const offsetOf = (rect: Rect): CSSProperties => {
        if (frame.origin == null) {
            return {};
        }
        const local = { x: frame.origin.x - frame.place.left, y: frame.origin.y - frame.place.top };
        const { dx, dy } = arrivalOffset(local, rect);
        return { ["--dx" as string]: `${dx}px`, ["--dy" as string]: `${dy}px` };
    };
    const delay = (i: number): CSSProperties => ({ ["--i" as string]: i * (ArrivalStepMs / 50) });
    // A narrow window takes some of his square's size during a brainstorm (#2285), so that the panel keeps its width.
    const squareSize = bs != null ? bs.square : g.square;
    const square: Rect = { x: 0, y: 0, w: squareSize, h: squareSize };
    const bodyLabel = (id: PanelId) => t(`boss.group.panels.${id}`);
    const railLabel = (id: PanelId): string => {
        const mark = marks[id];
        const label = bodyLabel(id);
        if (id === "notifications" && mark.count > 0) {
            return t("boss.group.rail.count", { name: label, count: mark.count });
        }
        if (id === "agents" && mark.dot) {
            return t("boss.group.rail.blocked", { name: label });
        }
        if (id === "downloads" && mark.ring != null) {
            return mark.ring >= 0
                ? t("boss.group.rail.running", { name: label, percent: Math.round(mark.ring * 100) })
                : t("boss.group.rail.runningUnknown", { name: label });
        }
        if (id === "downloads" && (mark.dot || mark.count > 0)) {
            return t("boss.group.rail.news", { name: label });
        }
        if (id === "keepawake") {
            return t(mark.ember ? "boss.group.rail.awake" : "boss.group.rail.awakeOff", { name: label });
        }
        return label;
    };
    const panelBody = () => {
        switch (active) {
            case "notifications":
                return (
                    <NotificationsPanel
                        rows={rows}
                        parked={toHandle.parked}
                        now={now}
                        workspaces={workspaces}
                        highlightIds={highlight}
                        actions={actions}
                        onLeave={leave}
                        onClose={closePanel}
                        onListed={onListed}
                    />
                );
            case "agents":
                return <AgentsPanel now={now} workspaces={workspaces} actions={actions} onClose={closePanel} />;
            case "sessions":
                return (
                    <SessionsPanel
                        now={now}
                        workspaces={workspaces}
                        actions={actions}
                        onLeave={leave}
                        onClose={closePanel}
                    />
                );
            case "downloads":
                return (
                    <DownloadsPanel
                        count={downloadItems.length + transfers.length}
                        onLeave={leave}
                        onClose={closePanel}
                    />
                );
            case "keepawake":
                return <BrokkKeepAwakePanel onLeave={leave} onClose={closePanel} />;
            default:
                return null;
        }
    };
    const activeIcon: PanelId = RailPanels.includes(active as PanelId) ? (active as PanelId) : null;
    const plink = activeIcon != null ? plinkLine(g, activeIcon, Math.min(height, heightRoom)) : null;
    // The square comes out of the face, so the thread starts with nothing out.
    const thread =
        frame.thread != null
            ? tetherLine(frame.thread.x, frame.thread.x + frame.thread.w, frame.thread.y + RopePx / 2, frame.thread.w)
            : null;

    return (
        <>
            <BrokkScrim
                shown={shown}
                onClose={() => {
                    if (closesCardIn(brainstorming, "outside")) {
                        boss.closeCard();
                    }
                }}
            />
            {holdsHover(panels) && !brainstorming ? (
                <div className="mt-brokk-catch" aria-hidden data-testid="brokk-hover-catch" />
            ) : null}
            {frame.thread != null ? (
                <Tether line={thread} open={shown} className="mt-brokk-thread" testId="brokk-thread" />
            ) : null}
            <div
                ref={rootRef}
                role="dialog"
                aria-modal="false"
                aria-label={t("boss.group.ariaLabel", { name })}
                tabIndex={-1}
                data-boss-card=""
                data-testid={CardTestId}
                data-shown={shown ? "true" : "false"}
                data-conversation={conversation ? "true" : undefined}
                data-pinned={pinned ? "true" : "false"}
                data-layout={bs != null ? "brainstorm" : undefined}
                className={cn("mt-brokk-group", shown && "is-in")}
                style={{
                    left: frame.place.left,
                    top: frame.place.top,
                    width: bs != null ? bs.width : g.width,
                    height: bs != null ? bs.height : flow.height,
                }}
                onPointerDownCapture={pin}
                onFocusCapture={pin}
                onPointerEnter={() => faceHover.enterGroup()}
                onPointerLeave={() => faceHover.leaveGroup()}
            >
                <div
                    className="mt-brokk-sq"
                    style={{ width: squareSize, height: squareSize, ...offsetOf(square), ...delay(0) }}
                    data-testid="brokk-square"
                    onContextMenu={showMenu}
                >
                    <button
                        type="button"
                        className="mt-brokk-sq-hit"
                        aria-label={t("boss.group.close", { name })}
                        data-testid="boss-card-close"
                        onClick={() => boss.closeCard()}
                    />
                    <div className="mt-brokk-sq-pic" data-testid="brokk-panel-portrait" aria-hidden>
                        <BossPortrait live={live} framing="banner" />
                    </div>
                    <div className="mt-brokk-scan" aria-hidden data-testid="brokk-scan" />
                    <div className="mt-brokk-vig" aria-hidden />
                    <div className="mt-brokk-name" aria-hidden data-testid="brokk-name">
                        <i />
                        {name.toLocaleUpperCase(locale)}
                    </div>
                    <button
                        type="button"
                        className="mt-brokk-sq-menu"
                        aria-label={t("boss.panel.menu", { name })}
                        title={t("boss.panel.menu", { name })}
                        aria-haspopup="menu"
                        data-testid="brokk-panel-menu"
                        onClick={showMenu}
                    >
                        <i className={makeIconClass("ellipsis", true)} aria-hidden />
                    </button>
                </div>
                {bs != null ? (
                    <div
                        className="mt-brokk-bspanel"
                        role="region"
                        aria-label={t("boss.brainstorm.panel.label")}
                        data-testid="brokk-brainstorm-panel"
                        style={{
                            left: bs.panel.x,
                            top: bs.panel.y,
                            width: bs.panel.w,
                            height: bs.panel.h,
                            ...offsetOf(bs.panel),
                            ...delay(1),
                        }}
                    >
                        <Suspense fallback={null}>
                            <BrainstormPanel />
                        </Suspense>
                    </div>
                ) : null}
                <div
                    className="mt-brokk-rail"
                    role="tablist"
                    aria-orientation="vertical"
                    aria-label={t("boss.group.rail.label", { name })}
                    data-testid="brokk-rail"
                    hidden={bs != null || undefined}
                    style={{
                        left: g.rail.x,
                        top: g.rail.y,
                        width: g.rail.w,
                        height: g.rail.h,
                        ...offsetOf(g.rail),
                        ...delay(1),
                    }}
                >
                    {RailPanels.map((id) => {
                        const icon = g.icons[id];
                        const on = active === id;
                        return (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                id={`brokk-rail-${id}`}
                                aria-selected={on}
                                aria-controls="brokk-panel"
                                aria-label={railLabel(id)}
                                title={railLabel(id)}
                                tabIndex={on || (active == null && id === RailPanels[0]) ? 0 : -1}
                                data-rail-id={id}
                                data-testid={`brokk-rail-${id}`}
                                data-active={on ? "true" : undefined}
                                className="mt-brokk-icon"
                                style={{ left: icon.x - g.rail.x, top: icon.y, width: icon.w, height: icon.h }}
                                onClick={() => clickIcon(id)}
                                onKeyDown={(e) => onRailKeyDown(e, id)}
                            >
                                <RailIcon id={id} mark={marks[id]} />
                                <RailMarkView mark={marks[id]} />
                            </button>
                        );
                    })}
                </div>
                {bs == null ? (
                    <div
                        className="mt-brokk-block"
                        data-testid="brokk-block"
                        style={{
                            top: g.block.y,
                            width: g.block.w,
                            minHeight: flow.block.h,
                            ...offsetOf(g.block),
                            ...delay(1),
                        }}
                    >
                        {hasLine ? (
                            <BrokkSay
                                line={line}
                                source={unseen != null && line !== moment?.text ? "session" : "moment"}
                                view={report}
                                onSize={onReportSize}
                                onHover={setReportHovered}
                                onFocusVisible={setReportFocused}
                            />
                        ) : null}
                        <div ref={usageRef} className="mt-brokk-usage" data-testid="brokk-usage">
                            {weekly.length === 0 ? (
                                <span className="mt-brokk-usage-empty" data-testid="brokk-usage-empty">
                                    {t("boss.panel.usage.empty")}
                                </span>
                            ) : (
                                <UsageWeekGrid rows={weekRows} now={now} />
                            )}
                        </div>
                    </div>
                ) : null}
                <div
                    className="mt-brokk-fieldbox"
                    style={{
                        top: fieldTop,
                        width: fieldSize.w,
                        height: fieldSize.h,
                        ...offsetOf(bs != null ? bs.talk : g.field),
                        ...delay(0),
                    }}
                    data-testid="brokk-fieldbox"
                    data-open={conversation || bs != null ? "true" : "false"}
                >
                    <BrokkTalk onTyping={setTyping} onFocusChange={onFocusChange} onContentHeight={setExchangeHeight} />
                </div>
                {active != null ? (
                    <>
                        {plink != null ? (
                            <Tether line={plink} open={shown} className="mt-brokk-plink" testId="brokk-plink" />
                        ) : null}
                        <div
                            ref={panelRef}
                            id="brokk-panel"
                            role="tabpanel"
                            aria-labelledby={activeIcon != null ? `brokk-rail-${activeIcon}` : undefined}
                            aria-label={activeIcon == null ? bodyLabel(active) : undefined}
                            className="mt-brokk-gpanel"
                            data-testid="brokk-panel"
                            data-panel={active}
                            style={{ left: g.panelLeft, top: 0, width: panelW, height: Math.min(height, heightRoom) }}
                        >
                            {panelBody()}
                        </div>
                    </>
                ) : null}
            </div>
        </>
    );
}
