// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A small segmented control (DS-SHELL-101), drawn like the notification preferences' Notify / Quiet / Off: a bordered
// track whose chosen segment is filled. It is a WAI-ARIA radio group with one tab stop; the arrows move and choose.

import { cn } from "@/util/util";
import { useRef } from "react";
import { moveRadio, radioTabStop } from "./workspace-edit-model";

export type Segment<T extends string> = { value: T; label: string; title?: string };

export function SegmentedControl<T extends string>({
    label,
    segments,
    selected,
    onSelect,
    className,
}: {
    label: string;
    segments: Segment<T>[];
    // Nothing is filled while no segment matches (a policy not chosen yet).
    selected: T;
    onSelect: (value: T) => void;
    className?: string;
}) {
    const groupRef = useRef<HTMLDivElement>(null);
    const values = segments.map((s) => s.value);
    const tabStop = radioTabStop(values, selected);
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const radios = Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
        const next = moveRadio(e.key, radios.indexOf(document.activeElement as HTMLElement), segments.length);
        if (next < 0) {
            return;
        }
        e.preventDefault();
        radios[next]?.focus();
        onSelect(values[next]);
    };
    return (
        <div
            ref={groupRef}
            role="radiogroup"
            aria-label={label}
            data-role="segmented"
            onKeyDown={onKeyDown}
            className={cn("inline-flex shrink-0 rounded-4 border border-border p-0.5", className)}
        >
            {segments.map((segment, i) => {
                const checked = segment.value === selected;
                return (
                    <button
                        key={segment.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        title={segment.title}
                        tabIndex={i === tabStop ? 0 : -1}
                        onClick={() => onSelect(segment.value)}
                        className={cn(
                            "cursor-pointer rounded-6 px-2 py-0.5 text-12 whitespace-nowrap transition-colors duration-120 ease-mt motion-reduce:transition-none",
                            "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                            checked ? "bg-hover text-primary" : "text-muted hover:text-primary"
                        )}
                    >
                        {segment.label}
                    </button>
                );
            })}
        </div>
    );
}
