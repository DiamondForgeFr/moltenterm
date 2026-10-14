// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's diff editor and its line selection (FR-REV-003, DS-REV-003), on MonacoDiffViewer's onMount: the
// selection of either side becomes the tab's (base = LEFT, head = RIGHT), its actions show next to it and answer
// Alt+A (Ask the AI) and Alt+C (Comment), and the file's comments show in the gutter of their side, coloured by state;
// a click on one opens it. Monaco comes from onMount, so nothing here loads it.

import { globalStore } from "@/app/store/jotaiStore";
import type * as MonacoTypes from "monaco-editor";
import { ReviewComment } from "./review-client";
import {
    commentAtLine,
    commentsOfFile,
    CommentStateLabels,
    isEmptySelection,
    linesLabel,
    makeAnchor,
    makeSelection,
    onEditorSide,
    ReviewSide,
    selectedLines,
} from "./review-selection";
import type { ReviewTabModel } from "./review-tab-model";

// The overlay sits this far right of the text's left edge.
const OverlayIndent = 12;

export type DiffActions = {
    dispose: () => void;
    // collapseSelection empties the editor's selection (after a comment is saved).
    collapseSelection: () => void;
    // reveal scrolls to a comment's lines.
    reveal: (comment: ReviewComment) => void;
};

type Editor = MonacoTypes.editor.IStandaloneCodeEditor;

const MarkdownSpecials = /[\\`*_{}[\]()#+\-.!|<>~]/g;

function escapeMarkdown(text: string): string {
    return text.replace(MarkdownSpecials, (c) => "\\" + c);
}

export function commentHover(comment: ReviewComment): string {
    const where =
        comment.subject === "file" ? "file-level, quoting " + linesLabel(comment.anchor) : linesLabel(comment.anchor);
    const what = comment.kind === "change" ? "change request" : "comment";
    return `**${CommentStateLabels[comment.state] ?? comment.state} ${what}** · ${where}\n\n${escapeMarkdown(comment.original.text)}`;
}

export function attachDiffActions(
    model: ReviewTabModel,
    diff: MonacoTypes.editor.IStandaloneDiffEditor,
    monacoApi: typeof MonacoTypes
): DiffActions {
    const sides: [Editor, ReviewSide][] = [
        [diff.getOriginalEditor(), "LEFT"],
        [diff.getModifiedEditor(), "RIGHT"],
    ];
    const disposables: MonacoTypes.IDisposable[] = [];
    const decorations = new Map<ReviewSide, MonacoTypes.editor.IEditorDecorationsCollection>();
    // The editor whose selection the tab shows.
    let active: Editor = null;

    const editorOf = (side: string): Editor => (side === "LEFT" ? sides[0][0] : sides[1][0]);

    const place = () => {
        const sel = globalStore.get(model.selectionAtom);
        const composer = globalStore.get(model.composerAtom);
        const anchor = composer?.anchor ?? sel?.anchor;
        if (anchor == null) {
            globalStore.set(model.overlayAtom, null);
            return;
        }
        const editor = composer != null ? editorOf(anchor.side) : active;
        const node = editor?.getDomNode();
        const container = diff.getContainerDomNode();
        if (node == null || container == null) {
            return;
        }
        const pos = editor.getScrolledVisiblePosition({ lineNumber: anchor.line, column: 1 });
        if (pos == null) {
            globalStore.set(model.overlayAtom, { top: 0, left: 0, visible: false });
            return;
        }
        const nodeRect = node.getBoundingClientRect();
        const boxRect = container.getBoundingClientRect();
        const top = nodeRect.top - boxRect.top + pos.top + pos.height;
        const left = nodeRect.left - boxRect.left + editor.getLayoutInfo().contentLeft + OverlayIndent;
        const visible = pos.top + pos.height > 0 && pos.top < nodeRect.height;
        globalStore.set(model.overlayAtom, { top, left, visible });
    };

    const takeSelection = (editor: Editor, side: ReviewSide) => {
        const selection = editor.getSelection();
        const textModel = editor.getModel();
        const path = globalStore.get(model.selectedAtom);
        if (selection == null || textModel == null || path == null) {
            return;
        }
        if (isEmptySelection(selection)) {
            if (active === editor) {
                active = null;
                globalStore.set(model.selectionAtom, null);
                if (globalStore.get(model.composerAtom) == null) {
                    globalStore.set(model.overlayAtom, null);
                }
            }
            return;
        }
        const [first, last] = selectedLines(selection);
        const text = textModel.getValueInRange({
            startLineNumber: first,
            startColumn: 1,
            endLineNumber: last,
            endColumn: textModel.getLineMaxColumn(last),
        });
        const view = globalStore.get(model.fileAtom);
        const since = globalStore.get(model.modeAtom) === "since";
        const anchor = makeAnchor(path, side, first, last, model.shownHead(), text);
        active = editor;
        globalStore.set(model.selectionAtom, makeSelection(anchor, text, view?.result?.hunks ?? [], since));
        if (globalStore.get(model.composerAtom)?.id == null) {
            globalStore.set(model.composerAtom, null);
        }
        place();
    };

    const render = () => {
        const state = globalStore.get(model.stateAtom);
        const path = globalStore.get(model.selectedAtom);
        const head = model.shownHead();
        const since = globalStore.get(model.modeAtom) === "since";
        const comments = commentsOfFile(state, path);
        for (const [editor, side] of sides) {
            const items: MonacoTypes.editor.IModelDeltaDecoration[] = [];
            for (const c of comments.filter((c) => onEditorSide(c, side, head, since))) {
                const start = c.anchor.startline ?? c.anchor.line;
                items.push({
                    range: new monacoApi.Range(start, 1, c.anchor.line, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: `molten-review-range molten-review-${c.state}`,
                    },
                });
                items.push({
                    range: new monacoApi.Range(start, 1, start, 1),
                    options: {
                        glyphMarginClassName: `molten-review-glyph molten-review-${c.state}`,
                        glyphMarginHoverMessage: { value: commentHover(c) },
                    },
                });
            }
            let collection = decorations.get(side);
            if (collection == null) {
                collection = editor.createDecorationsCollection();
                decorations.set(side, collection);
            }
            collection.set(items);
        }
    };

    for (const [editor, side] of sides) {
        disposables.push(
            editor.onDidChangeCursorSelection(() => takeSelection(editor, side)),
            editor.onDidScrollChange(() => place()),
            editor.onDidLayoutChange(() => place()),
            editor.onMouseDown((e) => {
                if (e.target.type !== monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                    return;
                }
                const line = e.target.position?.lineNumber;
                const state = globalStore.get(model.stateAtom);
                const shown = commentsOfFile(state, globalStore.get(model.selectedAtom)).filter((c) =>
                    onEditorSide(c, side, model.shownHead(), globalStore.get(model.modeAtom) === "since")
                );
                const comment = line != null ? commentAtLine(shown, line) : null;
                if (comment != null) {
                    model.editComment(comment);
                    place();
                }
            }),
            editor.onKeyDown((e) => {
                if (e.keyCode !== monacoApi.KeyCode.Escape) {
                    return;
                }
                if (globalStore.get(model.selectionAtom) != null || globalStore.get(model.composerAtom) != null) {
                    model.clearSelection();
                }
            }),
            // must match the shortcut registry's review-ask and review-comment
            editor.addAction({
                id: "molten.review.ask",
                label: "Ask the AI about these lines",
                keybindings: [monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyA],
                contextMenuGroupId: "navigation",
                run: () => {
                    takeSelection(editor, side);
                    model.askSelection();
                },
            }),
            editor.addAction({
                id: "molten.review.comment",
                label: "Comment these lines",
                keybindings: [monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyC],
                contextMenuGroupId: "navigation",
                run: () => {
                    takeSelection(editor, side);
                    model.openComposer();
                    place();
                },
            })
        );
    }
    disposables.push(diff.onDidUpdateDiff(() => render()));
    const unsubs = [globalStore.sub(model.stateAtom, render), globalStore.sub(model.composerAtom, place)];
    render();

    return {
        dispose: () => {
            for (const d of disposables) {
                d.dispose();
            }
            for (const unsub of unsubs) {
                unsub();
            }
            for (const collection of decorations.values()) {
                collection.clear();
            }
        },
        collapseSelection: () => {
            const pos = active?.getPosition();
            if (active != null && pos != null) {
                active.setSelection(new monacoApi.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
            }
        },
        reveal: (comment: ReviewComment) => {
            const editor = editorOf(comment.anchor.side);
            const start = comment.anchor.startline ?? comment.anchor.line;
            editor.revealLinesInCenterIfOutsideViewport(start, comment.anchor.line);
        },
    };
}
