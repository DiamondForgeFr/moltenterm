// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Deploy to shortcut (#559): the cd steps that name an environment, one direct button or a menu
// of them, run by the CD tab's own runner. A production-like environment, or one marked confirm, asks first in the
// same dialog the CD tab's Run button opens.

import { useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { MoltenWave } from "../molten-button";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { DeployRevision, DeployTarget, isProductionLike, revisionText } from "./deploy-model";
import { MenuPopover } from "./menu-popover";
import { RunStateBadge } from "./runs-view";
import { timeAgo } from "./time-format";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const ConfirmButton = "molten-btn molten-btn-warning cursor-pointer rounded-6 px-3 py-1.5 text-12";

// Runs the step at once, or hands the target to the confirmation first.
export function requestDeploy(
    target: DeployTarget,
    run: (stepId: string) => void,
    ask: (target: DeployTarget) => void
) {
    if (target.confirm) {
        ask(target);
        return;
    }
    run(target.stepId);
}

export function confirmReason(target: DeployTarget): string {
    if (isProductionLike(target.environment)) {
        return `${target.environment} is named like production.`;
    }
    return `The pipeline asks before every deploy to ${target.environment}.`;
}

export function DeployConfirmBody({ target, revision }: { target: DeployTarget; revision: DeployRevision }) {
    return (
        <>
            <p>
                <span className="text-secondary">{target.title}</span> deploys{" "}
                <code className="text-primary" data-testid="deploy-confirm-revision">
                    {revisionText(revision)}
                </code>{" "}
                to <span className="font-semibold text-primary">{target.environment}</span>.
            </p>
            <p className="text-muted">{confirmReason(target)}</p>
        </>
    );
}

function DeployConfirm({
    target,
    revision,
    onDeploy,
    onCancel,
}: {
    target: DeployTarget;
    revision: DeployRevision;
    onDeploy: () => void;
    onCancel: () => void;
}) {
    useEscape(true, onCancel);
    return (
        <DialogFrame
            role="deploy-confirm"
            title={`Deploy to ${target.environment}?`}
            trapFocus
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={onCancel} autoFocus>
                        Cancel
                    </button>
                    <button type="button" className={ConfirmButton} onClick={onDeploy}>
                        Deploy to {target.environment}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <DeployConfirmBody target={target} revision={revision} />
        </DialogFrame>
    );
}

// The deploy request shared by the header and the CD tab: `deploy` runs the step or asks first, `dialog` renders the
// question while it is open.
export function useConfirmedDeploy(revision: DeployRevision, run: (stepId: string) => void) {
    const [asking, setAsking] = useState<DeployTarget>(null);
    const deploy = (target: DeployTarget) => requestDeploy(target, run, setAsking);
    const dialog =
        asking != null ? (
            <DeployConfirm
                target={asking}
                revision={revision}
                onCancel={() => setAsking(null)}
                onDeploy={() => {
                    setAsking(null);
                    run(asking.stepId);
                }}
            />
        ) : null;
    return { deploy, dialog };
}

function LastDeploy({ target }: { target: DeployTarget }) {
    if (target.last == null) {
        return <span className="text-11 text-muted">Not deployed yet</span>;
    }
    return (
        <span className="flex items-center gap-1.5 text-11 text-muted">
            <RunStateBadge state={target.last.state} />
            {timeAgo(new Date(target.last.startedat).toISOString())}
        </span>
    );
}

export function DeployMenuView({
    targets,
    busy,
    open,
    setOpen,
    onChoose,
    onShowRun,
}: {
    targets: DeployTarget[];
    busy: boolean;
    open: boolean;
    setOpen: (open: boolean) => void;
    onChoose: (target: DeployTarget) => void;
    onShowRun: () => void;
}) {
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);
    if (targets.length === 0) {
        return null;
    }
    const running = targets.find((t) => t.last?.state === "running");
    if (running != null) {
        return (
            <button type="button" onClick={onShowRun} className={ActionRunningClass} data-testid="deploy-to">
                <RunningDot />
                Deploying to {running.environment}…
            </button>
        );
    }
    const busyTitle = busy ? "Another project step is running: one runs at a time" : undefined;
    if (targets.length === 1) {
        const target = targets[0];
        return (
            <button
                type="button"
                disabled={busy}
                onClick={() => onChoose(target)}
                className={ActionSecondaryClass}
                title={busyTitle ?? target.title}
                data-testid="deploy-to"
            >
                <i className="fa fa-solid fa-cloud-arrow-up text-11" />
                Deploy to {target.environment}
            </button>
        );
    }
    return (
        <div ref={setAnchor} className="relative">
            <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className={ActionSecondaryClass}
                title={busyTitle}
                data-testid="deploy-to"
            >
                <i className="fa fa-solid fa-cloud-arrow-up text-11" />
                Deploy to…
            </button>
            {open ? (
                <MenuPopover
                    anchor={anchor}
                    onClose={() => setOpen(false)}
                    className="flex w-72 flex-col gap-1.5"
                    ariaLabel="Deploy to"
                >
                    {targets.map((target) => (
                        <button
                            key={target.stepId}
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                onChoose(target);
                            }}
                            className="flex w-full cursor-pointer flex-col gap-0.5 rounded-6 border border-border px-3 py-2 text-left transition-colors duration-120 ease-mt hover:border-secondary/40 hover:bg-hover"
                            data-testid={`deploy-to-${target.environment}`}
                        >
                            <span className="flex items-center gap-2">
                                <span className="text-13 leading-5 font-medium text-primary">{target.environment}</span>
                                {target.confirm ? (
                                    <span className="text-11 text-warning" title={confirmReason(target)}>
                                        asks first
                                    </span>
                                ) : null}
                            </span>
                            <span className="truncate text-11 text-secondary" title={target.title}>
                                {target.title}
                            </span>
                            <LastDeploy target={target} />
                        </button>
                    ))}
                </MenuPopover>
            ) : null}
        </div>
    );
}

export function DeployMenu({
    targets,
    revision,
    busy,
    onRun,
    onShowRun,
}: {
    targets: DeployTarget[];
    revision: DeployRevision;
    busy: boolean;
    onRun: (stepId: string) => void;
    onShowRun: () => void;
}) {
    const [open, setOpen] = useState(false);
    const { deploy, dialog } = useConfirmedDeploy(revision, (stepId) => {
        onRun(stepId);
        onShowRun();
    });
    return (
        <>
            <DeployMenuView
                targets={targets}
                busy={busy}
                open={open}
                setOpen={setOpen}
                onChoose={deploy}
                onShowRun={onShowRun}
            />
            {dialog}
        </>
    );
}
