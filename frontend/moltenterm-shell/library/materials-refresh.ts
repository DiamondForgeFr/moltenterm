// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// An event invalidates the in-flight snapshot; the trailing read must observe the change it announces.
export function makeMaterialsRefresh<T>() {
    let target: { read: () => Promise<T>; publish: (value: T) => void; fail: (error: unknown) => void } = null;
    let running = false;
    let pending = false;
    let generation = 0;

    const request = () => {
        if (target == null) return;
        generation++;
        pending = true;
        run();
    };

    const run = () => {
        if (running || !pending || target == null) return;
        running = true;
        pending = false;
        const receiver = target;
        const started = generation;
        void (async () => {
            try {
                const value = await receiver.read();
                if (target === receiver && generation === started) receiver.publish(value);
            } catch (error) {
                if (target === receiver && generation === started) receiver.fail(error);
            } finally {
                running = false;
                run();
            }
        })();
    };

    const activate = (read: () => Promise<T>, publish: (value: T) => void, fail: (error: unknown) => void) => {
        const receiver = { read, publish, fail };
        target = receiver;
        request();
        return () => {
            if (target !== receiver) return;
            target = null;
            pending = false;
            generation++;
        };
    };
    return { activate, request };
}
