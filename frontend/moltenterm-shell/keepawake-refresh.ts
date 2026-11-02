// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Coalesces state reads and keeps retrying a failed read until it succeeds or the owner stops.
// Events received during a read require one more read, because that response may predate the event.
const InitialRetryMs = 2000;
const MaxRetryMs = 30000;

export class KeepAwakeRefresh<T> {
    timer: ReturnType<typeof setTimeout> = null;
    running = false;
    dirty = false;
    stopped = false;
    retryMs = InitialRetryMs;
    read: () => Promise<T>;
    apply: (state: T) => void;

    constructor(read: () => Promise<T>, apply: (state: T) => void) {
        this.read = read;
        this.apply = apply;
    }

    request(delay = 0): void {
        if (this.stopped) return;
        this.dirty = true;
        if (!this.running && this.timer == null) {
            if (delay > 0) {
                this.timer = setTimeout(() => {
                    this.timer = null;
                    void this.run();
                }, delay);
            } else {
                void this.run();
            }
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = null;
        this.dirty = false;
    }

    async run(): Promise<void> {
        if (this.stopped || this.running) return;
        this.running = true;
        this.dirty = false;
        try {
            const state = await this.read();
            if (this.stopped) return;
            this.apply(state);
            this.retryMs = InitialRetryMs;
        } catch (e) {
            if (this.stopped) return;
            console.log("keep-awake: state read failed", e);
            this.dirty = true;
            const delay = this.retryMs;
            this.retryMs = Math.min(this.retryMs * 2, MaxRetryMs);
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.run();
            }, delay);
        } finally {
            this.running = false;
            if (!this.stopped && this.dirty && this.timer == null) void this.run();
        }
    }
}
