// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export const SliderWriteInterval = 60;

type Intent = { revision: number; value: number | null };
export type SliderWriteState = { intent: Intent; failed: boolean; writing: boolean };

// The owner outlives the control: leaving a section must not cancel its last write. A key has only one request in
// flight, so a slow earlier request cannot restore an older choice after the final request completes.
export class SliderWrites {
    state: SliderWriteState = { intent: null, failed: false, writing: false };
    listeners = new Set<() => void>();
    pending: Intent = null;
    revision = 0;
    lastStart = -Infinity;
    timer: ReturnType<typeof setTimeout> = null;
    observed: unknown;
    confirmedRevision = 0;

    constructor(
        readonly persist: (value: number | null) => Promise<void>,
        readonly failure: (retry: () => void) => void,
        readonly clearFailure: () => void
    ) {}

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    snapshot = () => this.state;

    update(state: Partial<SliderWriteState>) {
        this.state = { ...this.state, ...state };
        this.listeners.forEach((listener) => listener());
    }

    select = (value: number | null) => {
        if (this.state.intent?.value === value && !this.state.failed) {
            return;
        }
        const intent = { revision: ++this.revision, value };
        this.pending = intent;
        this.clearFailure();
        this.update({ intent, failed: false });
        this.flush();
    };

    observe(value: unknown) {
        this.observed = value;
        const { intent, writing, failed } = this.state;
        if (intent && !writing && !failed && this.pending == null && this.confirmedRevision === intent.revision) {
            if ((value ?? null) === intent.value) {
                this.update({ intent: null });
            }
        }
    }

    retry = () => {
        if (!this.state.failed) {
            return;
        }
        this.pending = this.state.intent;
        this.clearFailure();
        this.update({ failed: false });
        this.flush();
    };

    flush = () => {
        if (this.pending == null || this.state.writing || this.timer != null) {
            return;
        }
        const wait = SliderWriteInterval - (Date.now() - this.lastStart);
        if (wait > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flush();
            }, wait);
            return;
        }
        const intent = this.pending;
        this.pending = null;
        this.lastStart = Date.now();
        this.update({ writing: true });
        void this.run(intent);
    };

    async run(intent: Intent) {
        try {
            await this.persist(intent.value);
            this.confirmedRevision = intent.revision;
            this.update({ writing: false });
            this.observe(this.observed);
        } catch (error) {
            console.error("settings: slider write failed", error);
            const failed = this.state.intent.revision === intent.revision;
            this.update({ writing: false, failed });
            if (failed) {
                this.failure(this.retry);
            }
        }
        this.flush();
    }
}
