// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcuts sheet (FR-SHELL-042-AC8, DS-SHELL-067): every shortcut of the registry, grouped by category, with a
// search field; Cmd+/ (again), Escape or Close dismiss it.

import { globalRefocusWithTimeout } from "@/app/store/keymodel";
import { isMacOS } from "@/util/platformutil";
import { useMemo, useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { keyCaps } from "./format";
import { platformShortcuts, Shortcut } from "./registry";
import { closeShortcutsSheet, ShortcutsSheetModalName } from "./shortcuts-keys";
import { filterShortcuts } from "./shortcuts-search";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

function Caps({ keys, mac }: { keys: string; mac: boolean }) {
    return (
        <span className="inline-flex items-center gap-0.5">
            {keyCaps(keys, mac).map((cap, i) => (
                <kbd
                    key={i}
                    className="min-w-[18px] rounded-4 border border-border bg-hoverbg px-1 text-center font-mono text-11 leading-[18px] text-primary"
                >
                    {cap}
                </kbd>
            ))}
        </span>
    );
}

function ShortcutKeys({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
    return (
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-11 text-muted">
            <Caps keys={shortcut.keys} mac={mac} />
            {shortcut.then?.length ? (
                <>
                    <span>then</span>
                    {shortcut.then.map((k) => (
                        <Caps key={k} keys={k} mac={mac} />
                    ))}
                </>
            ) : null}
            {(shortcut.alt ?? []).map((k) => (
                <span key={k} className="inline-flex items-center gap-1">
                    <span>or</span>
                    <Caps keys={k} mac={mac} />
                </span>
            ))}
        </span>
    );
}

export function MoltentermShortcutsSheet() {
    const [query, setQuery] = useState("");
    const mac = isMacOS();
    const sections = useMemo(() => filterShortcuts(platformShortcuts(mac), query, mac), [query, mac]);
    const close = () => {
        closeShortcutsSheet();
        globalRefocusWithTimeout(10);
    };
    useEscape(true, close);
    return (
        <DialogFrame
            role="shortcuts-sheet"
            title="Keyboard shortcuts"
            subtitle={mac ? undefined : "Alt plays the part of ⌘ on this system"}
            widthClass="w-[640px]"
            trapFocus={true}
            onBackdrop={close}
            buttons={
                <button type="button" className={PlainButton} onClick={close}>
                    Close
                </button>
            }
        >
            <input
                type="text"
                value={query}
                autoFocus
                spellCheck={false}
                placeholder="Search shortcuts…"
                aria-label="Search shortcuts"
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-4 border border-border bg-transparent px-2.5 py-1.5 text-13 leading-5 text-primary outline-none placeholder:text-muted focus:border-accent"
            />
            {sections.length === 0 ? <div className="py-2 text-muted">Nothing matches "{query}"</div> : null}
            {sections.map((section) => (
                <section key={section.category} aria-label={section.category}>
                    <h3 className="pb-1 text-11 font-semibold tracking-wide text-muted">{section.category}</h3>
                    <ul className="flex flex-col">
                        {section.shortcuts.map((s) => (
                            <li
                                key={s.id}
                                data-shortcut={s.id}
                                className="flex items-center justify-between gap-3 border-b border-border/40 py-1 last:border-b-0"
                            >
                                <span className="min-w-0 truncate text-13 text-secondary">{s.label}</span>
                                <ShortcutKeys shortcut={s} mac={mac} />
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </DialogFrame>
    );
}

MoltentermShortcutsSheet.displayName = ShortcutsSheetModalName;
