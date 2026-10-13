// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The title row every section of the companion starts with.

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
            <div className="text-11 font-semibold tracking-wide text-muted uppercase">{children}</div>
            <div className="ml-auto flex items-center gap-1">{right}</div>
        </div>
    );
}
