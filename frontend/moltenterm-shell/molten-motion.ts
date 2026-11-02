// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Molten motion (#1163): the app's one way to change an interface before the developer's eyes. molten-motion.css holds
// the look (flow-in, melt-out, move, the glow pass and the steady glow, the reduced-motion fade); this module holds
// the class names, the tokens' values for timers, and the helpers that put them on what changes. Documented in
// suite/suite-language.md ("Molten motion"). Any surface uses it the same way:
//   const rows = useFlowList(items, (i) => i.id);           // entering and leaving rows, leaving ones kept a moment
//   rows.map((r) => <div key={r.key} className={flowClass(r.phase)}><Row item={r.item} /></div>)
//   const glow = useGlowPass(signature);                      // "mt-glow-pass" for one flow after signature changes
//   useFlipMove(ref, [layoutKey]);                            // [data-motion-key] children travel to their new place

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./molten-motion.css";

export const MotionClass = {
    flowIn: "mt-flow-in",
    meltOut: "mt-melt-out",
    // A whole screen replacing another (a stepper's next step): keyed by the screen, it rises into place.
    arrive: "mt-arrive",
    move: "mt-move",
    glowPass: "mt-glow-pass",
    glow: "mt-glow",
} as const;

// must match --mt-duration-flow and --mt-duration-fade in tokens.css
export const MotionMs = {
    flow: 320,
    fade: 120,
} as const;

// The attribute useFlipMove follows.
export const MotionKeyAttr = "data-motion-key";

// The system's preference or MoltenTerm's own setting (the app root's class, set from prefersReducedMotionAtom).
export function prefersReducedMotion(doc: Document = globalThis.document): boolean {
    if (doc == null) {
        return false;
    }
    if (doc.querySelector(".prefers-reduced-motion") != null) {
        return true;
    }
    return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

// How long a change lasts here: the flow, or the fade under reduced motion.
export function motionMs(doc?: Document): number {
    return prefersReducedMotion(doc) ? MotionMs.fade : MotionMs.flow;
}

export type FlowPhase = "enter" | "stay" | "exit";

export type FlowEntry<T> = { key: string; item: T; phase: FlowPhase };

export function flowClass(phase: FlowPhase): string {
    if (phase === "enter") {
        return MotionClass.flowIn;
    }
    if (phase === "exit") {
        return MotionClass.meltOut;
    }
    return "";
}

// flowEntries merges the next items into the entries shown: a new key enters, a known one stays (an entering one keeps
// entering), and a key that left exits at its former place, after the entry that preceded it. first: the first list
// shown, which appears as it is.
export function flowEntries<T>(
    prev: FlowEntry<T>[],
    next: readonly T[],
    keyOf: (item: T) => string,
    first = false
): FlowEntry<T>[] {
    const before = new Map((prev ?? []).filter((e) => e.phase !== "exit").map((e) => [e.key, e]));
    const rtn: FlowEntry<T>[] = (next ?? []).map((item) => {
        const key = keyOf(item);
        const known = before.get(key);
        const phase: FlowPhase = first ? "stay" : known == null ? "enter" : known.phase;
        return { key, item, phase };
    });
    const present = new Set(rtn.map((e) => e.key));
    (prev ?? []).forEach((e, i) => {
        if (present.has(e.key)) {
            return;
        }
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
            const k = rtn.findIndex((r) => r.key === prev[j].key);
            if (k >= 0) {
                at = k + 1;
                break;
            }
        }
        rtn.splice(at, 0, { key: e.key, item: e.item, phase: "exit" });
        present.add(e.key);
    });
    return rtn;
}

// settled: entering entries stay, exiting ones go.
export function settledEntries<T>(entries: FlowEntry<T>[]): FlowEntry<T>[] {
    return entries.filter((e) => e.phase !== "exit").map((e) => (e.phase === "enter" ? { ...e, phase: "stay" } : e));
}

// useFlowList: the entries to draw for a list that changes live. Leaving items stay one flow to melt out. It follows
// the list's keys, so a new array of the same items each render is fine; a staying entry always carries the latest
// item.
export function useFlowList<T>(items: readonly T[], keyOf: (item: T) => string): FlowEntry<T>[] {
    const [entries, setEntries] = useState<FlowEntry<T>[]>(() => flowEntries([], items, keyOf, true));
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const keyRef = useRef(keyOf);
    keyRef.current = keyOf;
    const signature = (items ?? []).map(keyOf).join("\u0001");
    const firstRef = useRef(true);
    useEffect(() => {
        if (firstRef.current) {
            firstRef.current = false;
            return;
        }
        setEntries((prev) => flowEntries(prev, itemsRef.current, keyRef.current));
        const timer = setTimeout(() => setEntries((prev) => settledEntries(prev)), motionMs() + 20);
        return () => clearTimeout(timer);
    }, [signature]);
    const latest = new Map((items ?? []).map((item) => [keyOf(item), item]));
    return entries.map((e) => (e.phase !== "exit" && latest.has(e.key) ? { ...e, item: latest.get(e.key) } : e));
}

// useGlowPass: the glow pass class for one flow after signature changes (not on the first render). The class is
// dropped afterwards, so the next change passes again.
export function useGlowPass(signature: string): string {
    const [on, setOn] = useState(false);
    const last = useRef(signature);
    useEffect(() => {
        if (last.current === signature) {
            return;
        }
        last.current = signature;
        setOn(false);
        const raf = requestAnimationFrame(() => setOn(true));
        const timer = setTimeout(() => setOn(false), motionMs() + 20);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
        };
    }, [signature]);
    return on ? MotionClass.glowPass : "";
}

// useFlipMove: the elements under ref carrying data-motion-key travel from where they were to where the new layout put
// them (first, last, invert, play), instead of jumping. Works for HTML and for SVG groups positioned by their
// children's coordinates (never on an element whose own transform attribute places it: the style would replace it).
export function useFlipMove(ref: React.RefObject<Element>, deps: readonly unknown[]) {
    const rects = useRef(new Map<string, DOMRect>());
    useLayoutEffect(() => {
        const root = ref.current;
        if (root == null) {
            return;
        }
        const els = Array.from(root.querySelectorAll<HTMLElement | SVGElement>(`[${MotionKeyAttr}]`));
        const next = new Map<string, DOMRect>();
        const reduced = prefersReducedMotion(root.ownerDocument);
        for (const el of els) {
            const key = el.getAttribute(MotionKeyAttr);
            const rect = el.getBoundingClientRect();
            next.set(key, rect);
            const was = rects.current.get(key);
            if (was == null || reduced) {
                continue;
            }
            const dx = was.left - rect.left;
            const dy = was.top - rect.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                continue;
            }
            el.style.transition = "none";
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            void (el as HTMLElement).getBoundingClientRect();
            el.style.transition = "";
            el.classList.add(MotionClass.move);
            el.style.transform = "";
        }
        rects.current = next;
    }, deps);
}
