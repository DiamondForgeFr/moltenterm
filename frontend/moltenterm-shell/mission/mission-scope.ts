// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from "react";

// Values are hidden during the first render of a different project, before effects reset them.
export function useMissionScope<T>(key: string, initial: T) {
    const scope = useMemo(() => ({ reload: () => {} }), [key]);
    const [stored, setStored] = useState<{ scope: typeof scope; value: T }>(null);
    const setValue = useCallback(
        (update: T | ((value: T) => T)) => {
            setStored((current) => ({
                scope,
                value:
                    typeof update === "function"
                        ? (update as (value: T) => T)(current?.scope === scope ? current.value : initial)
                        : update,
            }));
        },
        [scope, initial]
    );
    const reload = useCallback(() => scope.reload(), [scope]);
    return { scope, value: stored?.scope === scope ? stored.value : initial, setValue, reload };
}
