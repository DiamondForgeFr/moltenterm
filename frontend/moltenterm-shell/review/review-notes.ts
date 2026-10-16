// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Kept explanations (FR-REV-008): the answers the developer keeps, a notes list per project stored by wavesrv in
// MoltenTerm's data folder (pkg/molten/review/notes.go), never in the project. A note's path:line links are read from
// the project's git at a commit that outlives the PR, so they still open after the merge removed its worktree.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { serverErrorText } from "../i18n/server-text";
import { ReviewRoute } from "./review-client";
import type { ReviewAnchor } from "./review-session";

// must match pkg/molten/review/notes.go
const NotesEvent = "molten:review:notes";
const NotesCommand = "moltenreviewnotes";
const NoteKeepCommand = "moltenreviewnotekeep";
const NoteRenameCommand = "moltenreviewnoterename";
const NoteDeleteCommand = "moltenreviewnotedelete";
const NoteFileCommand = "moltenreviewnotefile";

const CallTimeoutMs = 15_000;
const FileTimeoutMs = 95_000;

// must match Note in pkg/molten/review/notes.go
export type ReviewNote = {
    id: string;
    title: string;
    explanationid: string;
    technique?: string;
    question?: string;
    markdown: string;
    depth?: string;
    principles?: string[];
    sources?: string[];
    related?: string[];
    anchor?: ReviewAnchor;
    pr: { number: number; title?: string; url?: string; baseref?: string };
    headoid?: string;
    agent?: string;
    keptat: number;
    updatedat?: number;
};

export type ReviewNotes = { repo: string; notes: ReviewNote[]; updatedat?: number };

export type ReviewNoteFile = { file: string; commit: string; from: "merged" | "head" | "base" };

function call<T>(command: string, data: any, timeout = CallTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: ReviewRoute, timeout });
}

// notesScope: must match NotesScope in pkg/molten/review/notes.go.
export function notesScope(repo: string): string {
    return "reviewnotes:" + (repo ?? "").replace("/", "__").toLowerCase();
}

export function reviewNotes(repo: string): Promise<ReviewNotes> {
    return call(NotesCommand, { repo });
}

export function keepReviewNote(req: {
    repo: string;
    number: number;
    explanationid: string;
    prtitle?: string;
    prurl?: string;
    baseref?: string;
}): Promise<ReviewNotes> {
    return call(NoteKeepCommand, req);
}

export function renameReviewNote(repo: string, id: string, title: string): Promise<ReviewNotes> {
    return call(NoteRenameCommand, { repo, id, title });
}

export function deleteReviewNote(repo: string, id: string): Promise<ReviewNotes> {
    return call(NoteDeleteCommand, { repo, id });
}

export function reviewNoteFile(repo: string, id: string, dir: string, path: string): Promise<ReviewNoteFile> {
    return call(NoteFileCommand, { repo, id, dir, path }, FileTimeoutMs);
}

export function subscribeReviewNotes(repo: string, handler: (notes: ReviewNotes) => void): () => void {
    return waveEventSubscribeSingle({
        eventType: NotesEvent as WaveEventName,
        scope: notesScope(repo),
        handler: (event) => handler(event.data as ReviewNotes),
    });
}

// newestFirst: the notes as the Notes section lists them (AC2).
export function newestFirst(notes: readonly ReviewNote[]): ReviewNote[] {
    return [...(notes ?? [])].sort((a, b) => (b.keptat ?? 0) - (a.keptat ?? 0));
}

// filterNotes keeps the notes whose title, technique, text, question, principles, sources or PR hold every word of the
// filter, ignoring case and accents.
export function filterNotes(notes: readonly ReviewNote[], filter: string): ReviewNote[] {
    const words = fold(filter).split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return [...(notes ?? [])];
    }
    return (notes ?? []).filter((n) => {
        const text = fold(
            [
                n.title,
                n.technique,
                n.question,
                n.markdown,
                ...(n.principles ?? []),
                ...(n.sources ?? []),
                ...(n.related ?? []),
                n.anchor?.path,
                n.pr?.title,
                `#${n.pr?.number}`,
            ]
                .filter(Boolean)
                .join("\n")
        );
        return words.every((w) => text.includes(w));
    });
}

function fold(text: string): string {
    return (text ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
}

// keptNoteOf: the note kept from an answer of the PR, if any.
export function keptNoteOf(notes: readonly ReviewNote[], number: number, explanationId: string): ReviewNote {
    return (notes ?? []).find((n) => n.pr?.number === number && n.explanationid === explanationId) ?? null;
}

// useReviewNotes follows a project's notes: read once, then the notes event (another view, another window).
export function useReviewNotes(repo: string): { notes: ReviewNotes; error: string; set: (notes: ReviewNotes) => void } {
    const [notes, setNotes] = useState<ReviewNotes>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        setNotes(null);
        setError(null);
        if (!repo) {
            return;
        }
        let live = true;
        const unsubscribe = subscribeReviewNotes(repo, (next) => {
            if (live && next != null) {
                setNotes(next);
            }
        });
        fireAndForget(async () => {
            try {
                const next = await reviewNotes(repo);
                if (live) {
                    setNotes(next);
                }
            } catch (e) {
                if (live) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            live = false;
            unsubscribe();
        };
    }, [repo]);
    const set = useCallback((next: ReviewNotes) => {
        if (next != null) {
            setNotes(next);
        }
    }, []);
    return { notes, error, set };
}
