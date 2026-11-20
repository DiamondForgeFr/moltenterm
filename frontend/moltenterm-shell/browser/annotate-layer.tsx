// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comment mode of the web page panel (FR-BRW-017, DS-BRW-024, #2327, #2422). The page stays live under this layer:
// the marks are drawn in the page itself by the overlay its preload holds (emain/moltenterm-annotate-guest.ts), anchored to
// the document and to the elements under them, and this layer drives it and holds the comments, the toolbar, the field
// that opens beside a new mark with the focus in it, the list and the review. Nothing leaves before the click that sends.
// The rules of the comments, the keys and the agent proposed are in annotate-model.ts; wavesrv writes the report
// (pkg/molten/mission/annotate.go).

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentNameLocks } from "../agent-name-locks-store";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { ReviewsModel } from "../reviews/reviews-store";
import { upcomingGet } from "../reviews/reviews-upcoming-client";
import { useWorkspaceReviews } from "../reviews/reviews-workspace";
import { readWorkspaceProject } from "../workspace-project";
import { type Captured, captureComments } from "./annotate-capture";
import { GuestLink, readPlaced } from "./annotate-guest-link";
import { LinkChips, RefThumbs } from "./annotate-layer-parts";
import {
    type AnnotateState,
    type AnnotateTarget,
    annotateTargetOf,
    cancelEdit,
    clearAll,
    commentKeyAction,
    commitComment,
    discardPage,
    editZone,
    emptyState,
    eraseZone,
    fieldPlacement,
    layerKeyAction,
    linksOf,
    markViews,
    MaxCommentChars,
    MaxRefs,
    MaxRefsPerZone,
    pagesOf,
    removeRef,
    sameAddress,
    setComment,
    type Size,
    type Zone,
    zoneNumber,
    addZone,
    type Box,
} from "./annotate-model";
import { annotateColor } from "./annotate-paint";
import { attachReferences, fieldDragOver, fieldDrop, fieldPaste, MaxRefSourceBytes } from "./annotate-refs";
import { Review } from "./annotate-review";
import type { AnnotatedWebview, AnnotateOpen, AnnotateSession } from "./annotate-session";
import { CaptureBar, CommentList, CommentToolbar, NumberBadge, type PageAsk, pageLabel } from "./annotate-toolbar";
import { type FromGuest, type MarkKind, type StartMessage } from "./annotate-wire";
import { useTestContext } from "./test-context";

const FieldSize: Size = { w: 288, h: 176 };
// What a row of thumbnails and a row of link chips add to the comment field's height, for its placement.
const RefsRowPx = 56;
const LinksRowPx = 28;

// The comment field beside a mark, with the focus in it as soon as the mark is placed. box is the mark where the page
// shows it now, in the layer's pixels.
export function CommentField({
    zone,
    n,
    box,
    stage,
    note,
    onChange,
    onCommit,
    onCancel,
    onErase,
    onAttach,
    onRemoveRef,
}: {
    zone: Zone;
    n: number;
    box: Box;
    stage: Size;
    // Why the last image could not be attached, worded; "" when it could.
    note: string;
    onChange: (comment: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    onErase: () => void;
    onAttach: (files: File[], others: number) => void;
    onRemoveRef: (refId: number) => void;
}) {
    const t = useT();
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const field = ref.current;
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
    }, [zone.id]);
    // While typing, the chips follow the same rule wavesrv applies; the review shows the list wavesrv answers.
    const links = linksOf(zone.comment);
    const height = FieldSize.h + (zone.refs.length > 0 ? RefsRowPx : 0) + (links.length > 0 ? LinksRowPx : 0);
    const at = fieldPlacement(box, stage, { w: FieldSize.w, h: height });
    return (
        <div
            className="pointer-events-auto absolute z-30 flex flex-col gap-1.5 rounded-4 border border-border bg-surface-3 p-2 shadow-e2"
            style={{ left: at.x, top: at.y, width: FieldSize.w }}
            data-testid="browser-annotate-field"
            onDragOver={fieldDragOver}
            onDrop={(e) => fieldDrop(e, onAttach)}
        >
            <div className="flex items-center gap-1.5">
                <NumberBadge n={n} />
                <span className="min-w-0 flex-1 truncate text-11 font-medium text-secondary">
                    {t("browser.annotate.field.title", { n })}
                </span>
                <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
                    title={t("browser.annotate.field.erase")}
                    aria-label={t("browser.annotate.field.erase")}
                    onClick={onErase}
                    data-testid="browser-annotate-erase"
                >
                    <i className="fa fa-solid fa-trash-can text-11" aria-hidden />
                </button>
            </div>
            <textarea
                ref={ref}
                rows={3}
                value={zone.comment}
                maxLength={MaxCommentChars}
                placeholder={t("browser.annotate.field.placeholder")}
                aria-label={t("browser.annotate.field.title", { n })}
                className="w-full resize-none rounded-4 border border-border bg-surface-2 px-2 py-1.5 text-12 leading-4 text-primary outline-none focus:border-[var(--mt-action)]"
                data-testid="browser-annotate-comment"
                onChange={(e) => onChange(e.target.value)}
                onPaste={(e) => fieldPaste(e, onAttach)}
                onKeyDown={(e) => {
                    const action = commentKeyAction({
                        key: e.key,
                        shiftKey: e.shiftKey,
                        isComposing: e.nativeEvent.isComposing,
                    });
                    if (action == null || action === "newline") {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    if (action === "commit") {
                        onCommit();
                    } else {
                        onCancel();
                    }
                }}
            />
            <RefThumbs refs={zone.refs} onRemove={onRemoveRef} />
            <LinkChips links={links} />
            {note ? (
                <p
                    role="status"
                    className="text-11 leading-4 text-[var(--mt-state-warning)]"
                    data-testid="browser-annotate-ref-note"
                >
                    {note}
                </p>
            ) : null}
            <p className="text-11 leading-4 text-muted">{t("browser.annotate.field.hint")}</p>
            <p className="text-11 leading-4 text-muted">
                {t("browser.annotate.field.refsHint", { count: MaxRefsPerZone })}
            </p>
        </div>
    );
}

// Where the comments would go from this page: the checkout it is served from and the project's agents, as the version
// card reads them.
function useAnnotateTarget(url: string): AnnotateTarget {
    const workspace = useAtomValue(atoms.workspace);
    const workspaceDir = readWorkspaceProject(workspace).repo;
    const { answer } = useTestContext(url, workspaceDir);
    const projects = useWorkspaceReviews();
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const locks = useAtomValue(AgentNameLocks.getInstance().locksAtom);
    const sameProject = !!answer?.sameproject;
    const upcomingKnown = projects.find((p) => p.dir === workspaceDir)?.ctx.upcoming != null;
    useEffect(() => {
        // The agents on the branches come with the upcoming work, which the sidebar asks only while PRs are listed.
        if (workspaceDir && sameProject && !upcomingKnown) {
            upcomingGet(workspaceDir).catch(() => {});
        }
    }, [workspaceDir, sameProject, upcomingKnown]);
    const workspaceId = workspace?.oid ?? "";
    return useMemo(
        () => annotateTargetOf({ url, workspaceId, answer, workspaceDir, projects, asks, states, locks }),
        [url, workspaceId, answer, workspaceDir, projects, asks, states, locks]
    );
}

function zoomOf(webview: AnnotatedWebview): number {
    try {
        return webview?.getZoomFactor?.() || 1;
    } catch {
        return 1;
    }
}

function addressOf(webview: AnnotatedWebview, fallback: string): string {
    try {
        return webview?.getURL() || fallback;
    } catch {
        return fallback;
    }
}

type Phase = "draw" | "capturing" | "review";

function AnnotateLayer({
    session,
    open,
    shown,
    onClose,
}: {
    session: AnnotateSession;
    open: { tabId: string; url: string };
    // Hidden, never closed, while another tab of the panel is shown: the comments are there when this tab is back.
    shown: boolean;
    onClose: () => void;
}) {
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<AnnotateState>(emptyState);
    const [tool, setTool] = useState<MarkKind>("point");
    const [paused, setPaused] = useState(false);
    const [listOpen, setListOpen] = useState(false);
    const [phase, setPhase] = useState<Phase>("draw");
    const [address, setAddress] = useState(open.url);
    // The pages whose comments the developer chose to keep when the page changed.
    const [kept, setKept] = useState<string[]>([]);
    const [leaveAsk, setLeaveAsk] = useState(false);
    const [view, setView] = useState<{ id: number; box: Box }>(null);
    const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
    const [refNote, setRefNote] = useState("");
    const [progress, setProgress] = useState({ done: 0, total: 1 });
    const [captured, setCaptured] = useState<Captured>(null);
    const target = useAnnotateTarget(address);
    // The latest of everything the page's messages and the page's events read, so they never see an old render.
    const latest = useRef({ state, tool, paused, phase, address, shown });
    latest.current = { state, tool, paused, phase, address, shown };
    const linkRef = useRef<GuestLink>(null);
    const cancelRef = useRef(false);
    const aliveRef = useRef(true);
    const colorRef = useRef(annotateColor());
    const webview = session.webviewOf(open.tabId);
    const startMessage = (): StartMessage => ({
        type: "start",
        color: colorRef.current,
        tool: latest.current.tool,
        paused: latest.current.paused || latest.current.phase !== "draw",
        marks: markViews(latest.current.state, latest.current.address),
    });
    const escape = () => {
        const { state: s, phase: p } = latest.current;
        if (p === "capturing") {
            cancelRef.current = true;
            return;
        }
        const action = layerKeyAction("Escape", { review: p === "review", leaveAsk, zones: s.zones.length });
        if (action === "back") {
            setPhase("draw");
            setCaptured(null);
        } else if (action === "keep") {
            setLeaveAsk(false);
        } else if (action === "ask-leave") {
            setLeaveAsk(true);
        } else if (action === "leave") {
            onClose();
        }
    };
    const onGuest = (msg: FromGuest) => {
        switch (msg.type) {
            case "press":
                setLeaveAsk(false);
                setState((s) => (s.editing != null ? cancelEdit(s, s.editing.id) : s));
                return;
            case "placed": {
                const placed = readPlaced(msg);
                if (placed == null) {
                    return;
                }
                setRefNote("");
                setKept((k) => k.filter((a) => !sameAddress(a, placed.address)));
                setState((s) => addZone(s.editing != null ? cancelEdit(s, s.editing.id) : s, placed));
                return;
            }
            case "edit":
                setRefNote("");
                setState((s) => editZone(s.editing != null ? cancelEdit(s, s.editing.id) : s, msg.id));
                return;
            case "view":
                if (msg.id === latest.current.state.editing?.id) {
                    setView({ id: msg.id, box: msg.box });
                }
                return;
            case "key":
                escape();
                return;
        }
    };
    const onGuestRef = useRef(onGuest);
    onGuestRef.current = onGuest;
    useEffect(() => {
        aliveRef.current = true;
        if (webview == null) {
            return;
        }
        const link = new GuestLink(webview);
        linkRef.current = link;
        link.onMessage = (msg) => onGuestRef.current(msg);
        const detach = link.attach();
        // A new document starts with a fresh preload that knows nothing yet: it is told again where the marks are.
        const onReady = () => {
            setAddress(addressOf(webview, latest.current.address));
            link.send(startMessage());
        };
        const onNavigate = (e: { url?: string; isMainFrame?: boolean }) => {
            if (e?.isMainFrame === false) {
                return;
            }
            setAddress(e?.url || addressOf(webview, latest.current.address));
        };
        webview.addEventListener("dom-ready", onReady);
        webview.addEventListener("did-navigate", onNavigate);
        webview.addEventListener("did-navigate-in-page", onNavigate);
        setAddress(addressOf(webview, latest.current.address));
        link.send(startMessage());
        return () => {
            aliveRef.current = false;
            cancelRef.current = true;
            link.send({ type: "stop" });
            webview.removeEventListener("dom-ready", onReady);
            webview.removeEventListener("did-navigate", onNavigate);
            webview.removeEventListener("did-navigate-in-page", onNavigate);
            detach();
            linkRef.current = null;
        };
    }, [session, open.tabId, webview]);
    useEffect(() => {
        linkRef.current?.send({ type: "tool", tool });
    }, [tool]);
    const guestPaused = paused || phase !== "draw";
    useEffect(() => {
        linkRef.current?.send({ type: "pause", paused: guestPaused });
    }, [guestPaused]);
    const marks = markViews(state, address);
    const marksKey = marks.map((m) => `${m.id}:${m.n}:${m.active ? 1 : 0}`).join(",");
    useEffect(() => {
        linkRef.current?.send({ type: "marks", marks });
    }, [marksKey]);
    const editingId = state.editing?.id ?? 0;
    useEffect(() => {
        setView(null);
        linkRef.current?.send({ type: "track", id: editingId });
    }, [editingId]);
    useEffect(() => {
        session.setCount(open.tabId, state.zones.length);
    }, [session, open.tabId, state.zones.length]);
    const hasField = state.editing != null && phase === "draw";
    useEffect(() => {
        // The panel gives its focus to the page when it gains it; with a comment field open, the field is where the keys go.
        session.focusLayers.set(open.tabId, () => {
            const field = rootRef.current?.querySelector("textarea");
            if (field == null || !latest.current.shown) {
                return false;
            }
            field.focus();
            return true;
        });
        return () => {
            session.focusLayers.delete(open.tabId);
        };
    }, [session, open.tabId]);
    useEffect(() => {
        const el = rootRef.current;
        if (el == null) {
            return;
        }
        const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const editing = state.editing != null ? state.zones.find((z) => z.id === state.editing.id) : null;
    // The comments of a page that was left, which the developer has not yet said to keep or drop.
    const undecided = pagesOf(state.zones).filter(
        (p) => !sameAddress(p.address, address) && !kept.some((k) => sameAddress(k, p.address))
    );
    const pageAsk: PageAsk =
        undecided.length > 0
            ? {
                  count: undecided.reduce((n, p) => n + p.count, 0),
                  page: pageLabel(undecided[0].address),
                  pages: undecided.length,
              }
            : null;
    const leave = () => (state.zones.length > 0 ? setLeaveAsk(true) : onClose());
    const leaveRef = useRef(leave);
    leaveRef.current = leave;
    useEffect(() => {
        session.leaveLayers.set(open.tabId, () => {
            setPhase("draw");
            setCaptured(null);
            leaveRef.current();
        });
        return () => {
            session.leaveLayers.delete(open.tabId);
        };
    }, [session, open.tabId]);
    // The images a paste or a drop gave: each is prepared (checked, decoded, written again) and attached in turn; the
    // one that cannot be says why, in the field.
    const stateRef = useRef(state);
    stateRef.current = state;
    const attach = (zoneId: number, files: File[], others: number) => {
        setRefNote("");
        fireAndForget(async () => {
            const note = await attachReferences(zoneId, files, others, {
                getState: () => stateRef.current,
                setState: (next) => {
                    stateRef.current = next;
                    setState(next);
                },
            });
            if (note != null) {
                setRefNote(
                    t(`browser.annotate.ref.refused.${note}`, {
                        count: note === "zone" ? MaxRefsPerZone : MaxRefs,
                        limit: Math.round(MaxRefSourceBytes / 1048576),
                    })
                );
            }
        });
    };
    const startReview = () => {
        const link = linkRef.current;
        if (link == null || webview == null) {
            return;
        }
        setState((s) => (s.editing != null ? cancelEdit(s, s.editing.id) : s));
        setListOpen(false);
        setLeaveAsk(false);
        cancelRef.current = false;
        setProgress({ done: 0, total: 1 });
        setPhase("capturing");
        fireAndForget(async () => {
            const taken = await captureComments(
                {
                    link,
                    view: webview,
                    address: latest.current.address,
                    color: colorRef.current,
                    live: () => aliveRef.current && !cancelRef.current,
                    onProgress: (done, total) => setProgress({ done, total }),
                },
                stateRef.current.zones
            );
            if (!aliveRef.current) {
                return;
            }
            if (cancelRef.current) {
                setPhase("draw");
                return;
            }
            setCaptured(taken);
            setPhase("review");
        });
    };
    const field = editing != null && hasField ? editing : null;
    const zoom = zoomOf(webview);
    const fieldBox: Box =
        field != null && view != null && view.id === field.id
            ? { x: view.box.x * zoom, y: view.box.y * zoom, w: view.box.w * zoom, h: view.box.h * zoom }
            : { x: stage.w / 2, y: stage.h / 3, w: 1, h: 1 };
    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            className={cn("pointer-events-none absolute inset-0 z-20 outline-none", !shown && "hidden")}
            aria-label={t("browser.annotate.layerLabel")}
            data-testid="browser-annotate"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                escape();
            }}
        >
            {field != null ? (
                <CommentField
                    zone={field}
                    n={zoneNumber(state, field.id)}
                    box={fieldBox}
                    stage={stage}
                    note={refNote}
                    onAttach={(files, others) => attach(field.id, files, others)}
                    onRemoveRef={(refId) => {
                        setRefNote("");
                        setState((s) => removeRef(s, field.id, refId));
                    }}
                    onChange={(comment) => setState((s) => setComment(s, field.id, comment))}
                    onCommit={() => setState((s) => commitComment(s, field.id))}
                    onCancel={() => setState((s) => cancelEdit(s, field.id))}
                    onErase={() => setState((s) => eraseZone(s, field.id))}
                />
            ) : null}
            {phase === "draw" && listOpen ? (
                <CommentList
                    zones={state.zones}
                    address={address}
                    editingId={editingId}
                    onGo={(id) => linkRef.current?.send({ type: "reveal", id })}
                    onEdit={(id) => {
                        setRefNote("");
                        setState((s) => editZone(s.editing != null ? cancelEdit(s, s.editing.id) : s, id));
                        linkRef.current?.send({ type: "reveal", id });
                    }}
                    onErase={(id) => setState((s) => eraseZone(s, id))}
                />
            ) : null}
            {phase === "draw" ? (
                <CommentToolbar
                    tool={tool}
                    paused={paused}
                    count={state.zones.length}
                    listOpen={listOpen}
                    leaveAsk={leaveAsk}
                    pageAsk={pageAsk}
                    onTool={(kind) => {
                        setTool(kind);
                        setPaused(false);
                    }}
                    onPause={() => setPaused((p) => !p)}
                    onList={() => setListOpen((o) => !o)}
                    onClear={() => setState((s) => clearAll(s))}
                    onReview={startReview}
                    onClose={leave}
                    onDiscard={onClose}
                    onKeep={() => setLeaveAsk(false)}
                    onKeepPage={() => setKept((k) => [...k, ...undecided.map((p) => p.address)])}
                    onDiscardPage={() =>
                        setState((s) => undecided.reduce((next, p) => discardPage(next, p.address), s))
                    }
                />
            ) : null}
            {phase === "capturing" ? (
                <CaptureBar
                    done={progress.done}
                    total={progress.total}
                    onCancel={() => {
                        cancelRef.current = true;
                    }}
                />
            ) : null}
            {phase === "review" && captured != null ? (
                <Review
                    target={target}
                    zones={state.zones}
                    captured={captured}
                    onBack={() => {
                        setPhase("draw");
                        setCaptured(null);
                    }}
                    onDone={onClose}
                />
            ) : null}
        </div>
    );
}

// Mounted by the web page panel over its pages, one per tab in the mode (annotateLayers): nothing shows until it starts.
export function AnnotateHost({
    session,
    open,
    shown,
}: {
    session: AnnotateSession;
    open: AnnotateOpen;
    shown: boolean;
}) {
    return <AnnotateLayer session={session} open={open} shown={shown} onClose={() => session.close(open.tabId)} />;
}
