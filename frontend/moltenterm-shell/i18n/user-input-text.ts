// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// wavesrv's questions in the window (Wave's user input modal) in the interface language (#1831): a request may carry
// a pkg/molten/uimsg Text per field in moltentexts; the English field shows for a code unknown here.

import { serverText, type ServerText } from "./server-text";

const WordedFields = ["title", "querytext", "checkboxmsg", "oklabel", "cancellabel"] as const;

export function wordUserInputRequest(request: UserInputRequest): UserInputRequest {
    const texts = request?.moltentexts as Record<string, ServerText>;
    if (texts == null) {
        return request;
    }
    const rtn: UserInputRequest = { ...request };
    for (const field of WordedFields) {
        if (texts[field] != null) {
            rtn[field] = serverText(texts[field], request[field]);
        }
    }
    return rtn;
}
