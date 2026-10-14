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

export type SessionSectionSlots = {
    usage: React.ReactNode;
    agents: React.ReactNode;
    permission: React.ReactNode;
    topics: React.ReactNode;
    answer: React.ReactNode;
    todos: React.ReactNode;
    task: React.ReactNode;
    files: React.ReactNode;
};

// The order of a session's sections (#555, the developer's choice on PR #557): the plan usage and the agents at work
// first, then the topics, the answer, the tasks and the workspace task; the changed files last, collapsed.
export function SessionSections(slots: SessionSectionSlots) {
    return (
        <>
            {slots.usage != null ? <div className="mt-1.5">{slots.usage}</div> : null}
            {slots.agents}
            {slots.permission}
            {slots.topics}
            {slots.answer}
            {slots.todos}
            {slots.task}
            {slots.files}
        </>
    );
}
