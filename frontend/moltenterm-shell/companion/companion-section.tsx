// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The title row of a section drawn outside the dashboard's blocks (the workspace task's own card).

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 px-(--mt-companion-inset) pt-3 pb-1">
            <div className="text-11 font-semibold tracking-wide text-muted uppercase">{children}</div>
            <div className="ml-auto flex items-center gap-1">{right}</div>
        </div>
    );
}
