// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The preview's code editor reveals the line a terminal file link names (FR-SHELL-017): the link writes it in the
// block meta (term-copy.ts), the editor follows it while it is mounted, so a link to a file already open moves it.

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import type * as MonacoTypes from "monaco-editor";

// must match term-copy.ts
const LineMetaKey = "molten:line";
const ColMetaKey = "molten:col";
const LineSeqMetaKey = "molten:lineseq";

function revealLine(editor: MonacoTypes.editor.IStandaloneCodeEditor, line: number, col: number): void {
    const model = editor.getModel();
    if (model == null || !(line > 0)) {
        return;
    }
    const lineNumber = Math.min(line, model.getLineCount());
    const column = col > 0 ? Math.min(col, model.getLineMaxColumn(lineNumber)) : 1;
    editor.setPosition({ lineNumber, column });
    editor.revealLineInCenter(lineNumber);
}

// Reveals the block's line now and each time a link names it again; returns the disposer.
export function followPreviewLine(editor: MonacoTypes.editor.IStandaloneCodeEditor, blockId: string): () => void {
    const blockAtom = getWaveObjectAtom<Block>(makeORef("block", blockId));
    let lastSeq: unknown = undefined;
    const apply = () => {
        const meta = globalStore.get(blockAtom)?.meta;
        const seq = meta?.[LineSeqMetaKey];
        if (seq == null || seq === lastSeq) {
            return;
        }
        lastSeq = seq;
        revealLine(editor, Number(meta?.[LineMetaKey]), Number(meta?.[ColMetaKey]));
    };
    // The editor gets its text right after mounting.
    const timer = setTimeout(apply, 0);
    const unsub = globalStore.sub(blockAtom, apply);
    return () => {
        clearTimeout(timer);
        unsub();
    };
}
