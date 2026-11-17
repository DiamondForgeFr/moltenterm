// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Annotate a version (FR-BRW-017, DS-BRW-024, #2327): the developer freezes the web page panel's page into a capture,
// draws numbered rectangles on it and comments each, then hands them to an agent. This file holds what needs no DOM:
// the zones and what the developer does to them, where a comment field goes, the agent the zones are proposed to and
// why, and the request wavesrv answers (pkg/molten/mission/annotate.go). Pure.

import { type AgentNameLock, locksOfProject, sameProjectFolder } from "../agent-name-locks-model";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { leadOf } from "../reviews/reviews-card-model";
import type { LeadFacts, RebaseAsk } from "../reviews/reviews-model";
import { rebaseAskKey } from "../reviews/reviews-model";
import { cardInputOf } from "../reviews/reviews-sections-model";
import { type AgentBarFacts, branchAgents } from "../reviews/reviews-upcoming-model";
import { type TestContextAnswer } from "./test-context-model";
import { type ProjectFacts, reviewPrOf, versionOfAnswer } from "./version-card-model";

// must match AnnotateCommand and the statuses in pkg/molten/mission/annotate.go
export const AnnotateCommand = "moltenmissionannotate";

export const MaxZones = 20;
export const MaxCommentChars = 1000;
// A drag shorter than this, in pixels, in either direction is a click.
export const MinZonePx = 8;
const FieldGapPx = 8;

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

// A zone is a rectangle in fractions of the capture's width and height, so it keeps its place when the panel is resized.
export type Zone = { id: number; x: number; y: number; w: number; h: number; comment: string; refs: ZoneRef[] };

// A reference image the developer attached to a zone's comment: what the window wrote again from a pasted or dropped
// image, as a data URL (annotate-refs.ts).
export type ZoneRef = { id: number; dataUrl: string };

// editing: the zone whose comment field is open; fresh: it was just drawn and its comment never validated.
export type AnnotateState = {
    zones: Zone[];
    nextId: number;
    nextRefId: number;
    editing: { id: number; fresh: boolean };
};

export function emptyState(): AnnotateState {
    return { zones: [], nextId: 1, nextRefId: 1, editing: null };
}

// The reference images of a zone and of a report: wavesrv holds the same limits, so that the websocket's 10 MB carries
// the capture and the references.
export const MaxRefsPerZone = 4;
export const MaxRefs = 8;

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

// dragRect: the rectangle two points make, in fractions of the stage, or null for a click.
export function dragRect(a: Point, b: Point, stage: Size): Rect {
    if (!(stage?.w > 0) || !(stage?.h > 0)) {
        return null;
    }
    const x1 = Math.min(Math.max(0, Math.min(a.x, b.x)), stage.w);
    const y1 = Math.min(Math.max(0, Math.min(a.y, b.y)), stage.h);
    const x2 = Math.min(Math.max(0, Math.max(a.x, b.x)), stage.w);
    const y2 = Math.min(Math.max(0, Math.max(a.y, b.y)), stage.h);
    if (x2 - x1 < MinZonePx || y2 - y1 < MinZonePx) {
        return null;
    }
    return { x: clamp01(x1 / stage.w), y: clamp01(y1 / stage.h), w: (x2 - x1) / stage.w, h: (y2 - y1) / stage.h };
}

export function zoneNumber(state: AnnotateState, id: number): number {
    return state.zones.findIndex((z) => z.id === id) + 1;
}

// addZone: the new zone opens its comment field. At the limit nothing is added.
export function addZone(state: AnnotateState, rect: Rect): AnnotateState {
    if (rect == null || state.zones.length >= MaxZones) {
        return state;
    }
    const zone: Zone = { id: state.nextId, ...rect, comment: "", refs: [] };
    return { ...state, zones: [...state.zones, zone], nextId: state.nextId + 1, editing: { id: zone.id, fresh: true } };
}

export function refCount(state: AnnotateState): number {
    return state.zones.reduce((n, z) => n + z.refs.length, 0);
}

// attachRef: a reference image on a zone. A zone holds MaxRefsPerZone and a report MaxRefs: past either nothing is added
// and the limit says which. Erasing a zone, or clearing all, takes its images with it.
export function attachRef(
    state: AnnotateState,
    zoneId: number,
    dataUrl: string
): { state: AnnotateState; refused: "" | "zone" | "report" } {
    const zone = state.zones.find((z) => z.id === zoneId);
    if (zone == null || !dataUrl) {
        return { state, refused: "" };
    }
    if (zone.refs.length >= MaxRefsPerZone) {
        return { state, refused: "zone" };
    }
    if (refCount(state) >= MaxRefs) {
        return { state, refused: "report" };
    }
    const ref: ZoneRef = { id: state.nextRefId, dataUrl };
    return {
        state: {
            ...state,
            nextRefId: state.nextRefId + 1,
            zones: state.zones.map((z) => (z.id === zoneId ? { ...z, refs: [...z.refs, ref] } : z)),
        },
        refused: "",
    };
}

export function removeRef(state: AnnotateState, zoneId: number, refId: number): AnnotateState {
    return {
        ...state,
        zones: state.zones.map((z) => (z.id === zoneId ? { ...z, refs: z.refs.filter((r) => r.id !== refId) } : z)),
    };
}

// A link in a comment: the http and https addresses it holds, in order, once each, at most MaxLinksPerZone, as wavesrv
// finds them (annotateLinks): the same words list them in the brief. Any other scheme (file:, javascript:, data:) is
// plain text, never a link. Nothing is fetched: the chip shows the host name.
export const MaxLinksPerZone = 5;
export type ZoneLink = { href: string; host: string };

const LinkPattern = /\bhttps?:\/\/[^\s<>"'`/][^\s<>"'`]*/gi;

export function linksOf(comment: string): ZoneLink[] {
    const out: ZoneLink[] = [];
    const seen = new Set<string>();
    for (const found of (comment ?? "").match(LinkPattern) ?? []) {
        let raw = found.replace(/[.,;:!?'"]+$/, "");
        while (raw.endsWith(")") && raw.split("(").length < raw.split(")").length) {
            raw = raw.slice(0, -1);
        }
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            continue;
        }
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
            continue;
        }
        url.username = "";
        url.password = "";
        url.hash = "";
        if (seen.has(url.href)) {
            continue;
        }
        seen.add(url.href);
        out.push({ href: url.href, host: url.host });
        if (out.length === MaxLinksPerZone) {
            break;
        }
    }
    return out;
}

export function editZone(state: AnnotateState, id: number): AnnotateState {
    if (!state.zones.some((z) => z.id === id)) {
        return state;
    }
    return { ...state, editing: { id, fresh: false } };
}

export function setComment(state: AnnotateState, id: number, comment: string): AnnotateState {
    return {
        ...state,
        zones: state.zones.map((z) => (z.id === id ? { ...z, comment: comment.slice(0, MaxCommentChars) } : z)),
    };
}

// commitComment: Enter validates the zone as typed; its field closes and the next zone can be drawn at once.
export function commitComment(state: AnnotateState, id: number): AnnotateState {
    if (state.editing?.id !== id) {
        return state;
    }
    return { ...state, editing: null };
}

// cancelEdit: Escape in a comment field. A new zone with no comment and no image is dropped; any other zone keeps what was typed,
// since nothing the developer wrote is lost to a key.
export function cancelEdit(state: AnnotateState, id: number): AnnotateState {
    const zone = state.zones.find((z) => z.id === id);
    if (zone == null || state.editing?.id !== id) {
        return state;
    }
    if (state.editing.fresh && zone.comment.trim() === "" && zone.refs.length === 0) {
        return eraseZone(state, id);
    }
    return commitComment(state, id);
}

export function eraseZone(state: AnnotateState, id: number): AnnotateState {
    return {
        ...state,
        zones: state.zones.filter((z) => z.id !== id),
        editing: state.editing?.id === id ? null : state.editing,
    };
}

export function clearAll(state: AnnotateState): AnnotateState {
    return { ...state, zones: [], editing: null };
}

// zoneAt: the zone under a point of the stage, in fractions; of several, the smallest, so a zone drawn inside another
// is the one a click reaches.
export function zoneAt(zones: Zone[], p: Point): Zone {
    let found: Zone = null;
    for (const z of zones) {
        if (p.x < z.x || p.x > z.x + z.w || p.y < z.y || p.y > z.y + z.h) {
            continue;
        }
        if (found == null || z.w * z.h < found.w * found.h) {
            found = z;
        }
    }
    return found;
}

export type Gesture = { kind: "draw"; rect: Rect } | { kind: "edit"; id: number } | { kind: "none" };

// gestureOf: what a press and a release on the stage do, points in pixels of the stage. A drag makes a zone; a click on
// a zone edits it, even where a drag would have started; a click elsewhere, and a drag too thin to be a zone, do nothing.
export function gestureOf(start: Point, end: Point, stage: Size, zones: Zone[]): Gesture {
    const rect = dragRect(start, end, stage);
    if (rect != null) {
        return { kind: "draw", rect };
    }
    if (
        Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) >= MinZonePx ||
        !(stage?.w > 0) ||
        !(stage?.h > 0)
    ) {
        return { kind: "none" };
    }
    const hit = zoneAt(zones, { x: start.x / stage.w, y: start.y / stage.h });
    return hit != null ? { kind: "edit", id: hit.id } : { kind: "none" };
}

export type CommentKeyAction = "commit" | "cancel" | "newline";

// commentKeyAction: a key in a comment field. Enter validates the zone and Shift+Enter adds a line; Escape closes the
// field. Enter that confirms an input method's composition is not a validation.
export function commentKeyAction(e: { key: string; shiftKey: boolean; isComposing?: boolean }): CommentKeyAction {
    if (e.isComposing) {
        return null;
    }
    if (e.key === "Enter") {
        return e.shiftKey ? "newline" : "commit";
    }
    return e.key === "Escape" ? "cancel" : null;
}

export type LayerKeyAction = "leave" | "ask-leave" | "keep" | "back";

// layerKeyAction: Escape outside a comment field. From the review it goes back to drawing; with zones drawn the first
// asks before they are lost, and a second one keeps them; with none it leaves.
export function layerKeyAction(
    key: string,
    ctx: { review: boolean; leaveAsk: boolean; zones: number }
): LayerKeyAction {
    if (key !== "Escape") {
        return null;
    }
    if (ctx.review) {
        return "back";
    }
    if (ctx.leaveAsk) {
        return "keep";
    }
    return ctx.zones > 0 ? "ask-leave" : "leave";
}

// fieldPlacement: where a comment field of the given size goes, in pixels of the stage: beside its zone (right, else
// left), else under or over it, always inside the stage.
export function fieldPlacement(zone: Rect, stage: Size, field: Size): Point {
    const box = { x: zone.x * stage.w, y: zone.y * stage.h, w: zone.w * stage.w, h: zone.h * stage.h };
    const keep = (p: Point): Point => ({
        x: Math.max(FieldGapPx, Math.min(p.x, stage.w - field.w - FieldGapPx)),
        y: Math.max(FieldGapPx, Math.min(p.y, stage.h - field.h - FieldGapPx)),
    });
    const right = box.x + box.w + FieldGapPx;
    if (right + field.w + FieldGapPx <= stage.w) {
        return keep({ x: right, y: box.y });
    }
    const left = box.x - FieldGapPx - field.w;
    if (left >= FieldGapPx) {
        return keep({ x: left, y: box.y });
    }
    const below = box.y + box.h + FieldGapPx;
    if (below + field.h + FieldGapPx <= stage.h) {
        return keep({ x: box.x, y: below });
    }
    return keep({ x: box.x, y: box.y - FieldGapPx - field.h });
}

export type ZoneWire = { comment: string; images?: string[]; imagecount?: number };

// zonesWire: the comments in order, trimmed, with the reference images as data URLs; a preview carries only their count,
// so that the images are not sent twice.
export function zonesWire(zones: Zone[], preview = false): ZoneWire[] {
    return zones.map((z) => {
        const wire: ZoneWire = { comment: z.comment.trim() };
        if (z.refs.length > 0) {
            if (preview) {
                wire.imagecount = z.refs.length;
            } else {
                wire.images = z.refs.map((r) => r.dataUrl);
            }
        }
        return wire;
    });
}

// The agent the zones are proposed to, and why: it works on the version's worktree; it owns the sub-agent that does (the
// zones are for it to dispatch); the pull request's signature names it; a first name is locked for the project and it
// holds it; or it is a live agent of the project. Anything but "works" asks the agent to dispatch (lead).
export type RecipientWhy = "works" | "owns" | "pr" | "locked" | "project";

export type Recipient = { blockId: string; name: string; agent?: string; why: RecipientWhy; lead: boolean };

export type RecipientInput = {
    // Activity is per workspace (only Brokk crosses them): the window's workspace, whose agents alone are offered. With
    // none known, nobody is.
    workspaceId: string;
    worktree: boolean;
    // The project's folder when one is known: only its agents are offered; without one, the workspace's agents are.
    projectDir: string;
    onBranch: AgentBarFacts[];
    prLead: LeadFacts;
    states: AgentStateInfo[];
    locks: AgentNameLock[];
};

function liveAgents(states: AgentStateInfo[]): AgentStateInfo[] {
    return (states ?? []).filter((s) => s?.blockid && !s.own && !s.cleared && (s.firstname ?? "").trim() !== "");
}

// recipientsOf: every agent the zones may go to, the proposed one first. The picker lists them in this order.
export function recipientsOf(input: RecipientInput): Recipient[] {
    const inScope = (s: AgentStateInfo) =>
        !!input.workspaceId &&
        s.workspaceid === input.workspaceId &&
        (!input.projectDir || sameProjectFolder(s.project ?? "", input.projectDir));
    const live = liveAgents(input.states).filter(inScope);
    const byBlock = new Map(live.map((s) => [s.blockid, s]));
    const out: Recipient[] = [];
    const add = (blockId: string, why: RecipientWhy) => {
        const s = byBlock.get(blockId);
        if (s == null || out.some((r) => r.blockId === blockId)) {
            return;
        }
        out.push({ blockId, name: s.firstname.trim(), agent: s.agent, why, lead: why !== "works" });
    };
    for (const a of input.onBranch ?? []) {
        if (a.kind === "panel" && a.blockId && !a.visiting) {
            add(a.blockId, input.worktree ? "works" : "project");
        }
    }
    for (const a of input.onBranch ?? []) {
        if (a.kind !== "panel" && a.parentBlockId) {
            add(a.parentBlockId, "owns");
        }
    }
    const signer = input.prLead;
    if (signer != null) {
        const named = signer.name.trim().toLowerCase();
        const found =
            (signer.blockId && byBlock.has(signer.blockId) ? signer.blockId : "") ||
            live.find((s) => named !== "" && s.firstname.trim().toLowerCase() === named)?.blockid;
        if (found) {
            add(found, "pr");
        }
    }
    for (const lock of locksOfProject(input.locks, input.projectDir)) {
        const holder = live.find((s) => s.firstname.trim() === lock.name);
        if (holder != null) {
            add(holder.blockid, "locked");
        }
    }
    const project = [...live].sort(
        (a, b) => (a.started ?? 0) - (b.started ?? 0) || a.firstname.localeCompare(b.firstname)
    );
    for (const s of project) {
        add(s.blockid, "project");
    }
    return out;
}

// resolveRecipient: the agent the review sends to. With no pick of the developer's it is the one proposed; an agent the
// developer picked and that has since gone is never replaced by another: nothing is chosen, and the review says who
// went, until a new pick.
export function resolveRecipient(
    recipients: Recipient[],
    picked: { blockId: string; name: string }
): { chosen: Recipient; lost: string } {
    if (picked == null) {
        return { chosen: recipients[0] ?? null, lost: "" };
    }
    const found = recipients.find((r) => r.blockId === picked.blockId);
    return found != null ? { chosen: found, lost: "" } : { chosen: null, lost: picked.name };
}

export type AnnotateTarget = {
    address: string;
    // The checkout the page is served from; "" for a page served from none.
    root: string;
    // The project's folder, for the capture's material when the page has no checkout.
    dir: string;
    branch: string;
    // The window's workspace: wavesrv sends only to an agent whose terminal is in it.
    workspaceId: string;
    recipients: Recipient[];
};

export type AnnotateTargetInput = {
    url: string;
    workspaceId: string;
    answer: TestContextAnswer;
    workspaceDir: string;
    projects: ProjectFacts[];
    asks: Record<string, RebaseAsk>;
    states: AgentStatesData;
    locks: AgentNameLock[];
};

// annotateTargetOf: where the zones go from this page: the checkout it is served from (the card's own reading of the
// tab's answer) and the agents of its project.
export function annotateTargetOf(input: AnnotateTargetInput): AnnotateTarget {
    const { answer, workspaceDir } = input;
    const version = versionOfAnswer(answer, workspaceDir);
    const dir = version != null ? (answer.sameproject ? workspaceDir : (answer.project ?? "")) : workspaceDir;
    const project = version?.projectdir ? (input.projects.find((p) => p.dir === version.projectdir) ?? null) : null;
    const pr = project != null && version != null ? reviewPrOf(project, version) : null;
    const onBranch =
        project?.ctx != null && version?.branch
            ? branchAgents(project.ctx.upcoming, project.ctx.states, version.branch, version.ticket, pr?.number ?? 0)
            : [];
    const prLead =
        pr != null && project?.ctx != null
            ? leadOf(cardInputOf(pr, input.asks?.[rebaseAskKey(project.dir, pr.number)], project.ctx))
            : null;
    return {
        address: input.url,
        root: version?.root ?? "",
        dir: dir ?? "",
        branch: version?.branch ?? "",
        workspaceId: input.workspaceId ?? "",
        recipients: recipientsOf({
            workspaceId: input.workspaceId ?? "",
            worktree: !!version?.worktree,
            projectDir: dir ?? "",
            onBranch,
            prLead,
            states: Object.values(input.states?.states ?? {}),
            locks: input.locks,
        }),
    };
}

// What wavesrv answers. must match AnnotateRequest and AnnotateResult in pkg/molten/mission/annotate.go
export type AnnotateAction = "preview" | "copy" | "send";

export type AnnotateRequest = {
    action: AnnotateAction;
    address: string;
    root?: string;
    dir?: string;
    branch?: string;
    workspaceid?: string;
    title?: string;
    image?: string;
    zones: ZoneWire[];
    reftitle?: string;
    to?: { blockid: string; firstname: string; agent?: string; lead?: boolean };
};

export type AnnotateResult = {
    status: "preview" | "copied" | "sent" | "noagent" | "refused";
    reason?: "workspace" | "project";
    text?: string;
    imagepath?: string;
    materialid?: string;
    delivery?: "delivered" | "typed" | "queued";
    to?: string;
    briefpath?: string;
    references?: string[][];
};

export function annotateRequest(
    action: AnnotateAction,
    target: AnnotateTarget,
    zones: Zone[],
    extra: { title?: string; refTitle?: string; image?: string; to?: Recipient }
): AnnotateRequest {
    const req: AnnotateRequest = { action, address: target.address, zones: zonesWire(zones, action === "preview") };
    if (target.root) {
        req.root = target.root;
    } else if (target.dir) {
        req.dir = target.dir;
    }
    if (target.branch) {
        req.branch = target.branch;
    }
    if (target.workspaceId) {
        req.workspaceid = target.workspaceId;
    }
    if (action !== "preview") {
        req.title = extra.title;
        req.image = extra.image;
        req.reftitle = extra.refTitle;
    }
    // The recipient's role changes the text (a lead is asked to dispatch), so the preview and the copy say it too.
    if (extra.to != null) {
        req.to = { blockid: extra.to.blockId, firstname: extra.to.name, agent: extra.to.agent, lead: extra.to.lead };
    }
    return req;
}
