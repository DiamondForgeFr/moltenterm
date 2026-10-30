// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export function makeSentRefresh<T>() {
    let target: {
        read: (current: () => boolean) => Promise<T>;
        publish: (value: T) => void;
        onError: (error: unknown) => void;
    } = null;
    let running = false;
    let pending = false;
    let mutations = 0;
    let generation = 0;

    const request = () => {
        if (target == null) return;
        pending = true;
        if (running || mutations > 0) return;
        pending = false;
        running = true;
        const started = generation;
        const receiver = target;
        const current = () => target === receiver && started === generation;
        void (async () => {
            try {
                const value = await receiver.read(current);
                if (current() && mutations === 0) receiver.publish(value);
            } catch (error) {
                if (current()) {
                    try {
                        receiver.onError(error);
                    } catch {
                        // The reporter must not strand the refresh loop.
                    }
                }
            } finally {
                running = false;
                if (pending && target != null && mutations === 0) request();
            }
        })();
    };

    const mutate = async <R>(action: () => Promise<R>): Promise<R> => {
        generation++;
        mutations++;
        try {
            return await action();
        } finally {
            mutations--;
            request();
        }
    };

    const activate = (
        read: (current: () => boolean) => Promise<T>,
        publish: (value: T) => void,
        onError: (error: unknown) => void
    ) => {
        const receiver = { read, publish, onError };
        target = receiver;
        generation++;
        request();
        return () => {
            if (target !== receiver) return;
            target = null;
            pending = false;
            generation++;
        };
    };
    return { request, mutate, activate };
}
