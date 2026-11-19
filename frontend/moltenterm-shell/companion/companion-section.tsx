// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The title row every section of the companion starts with, and the sections in the layout's order.

import { Fragment } from "react";
import {
    ColumnsBand,
    CompanionLayout,
    CompanionSectionId,
    DefaultCompanionLayout,
    sectionBands,
} from "./companion-layout";

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
            <div className="text-11 font-semibold tracking-wide text-muted uppercase">{children}</div>
            <div className="ml-auto flex items-center gap-1">{right}</div>
        </div>
    );
}

// What each section shows; a section given null, or none, has nothing to show and takes no place.
export type SessionSectionSlots = Partial<Record<CompanionSectionId, React.ReactNode>>;

// The sections of a session in the layout's order (companion-layout.ts, the defaults there): a full-width section as
// its slot gives it; a band of columns through columns, which lays its sections side by side or stacked, the Tasks
// block and the agents at work among them.
export function SessionSections({
    slots,
    columns,
    layout = DefaultCompanionLayout,
}: {
    slots: SessionSectionSlots;
    columns: (band: ColumnsBand) => React.ReactNode;
    layout?: CompanionLayout;
}) {
    // The Tasks block and the agents at work are drawn by the band itself, from the session.
    const present = (id: CompanionSectionId) => id === "tasks" || id === "agents" || slots[id] != null;
    return (
        <>
            {sectionBands(layout, present).map((band) =>
                band.kind === "full" ? (
                    <Fragment key={band.id}>
                        {band.id === "usage" ? <div className="mt-1.5">{slots.usage}</div> : slots[band.id]}
                    </Fragment>
                ) : (
                    <Fragment key={`columns:${band.ids.join(",")}`}>{columns(band)}</Fragment>
                )
            )}
        </>
    );
}
