// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A PR's notification opens its card (#1130, FR-REV-001 AC2): a click on the notification, or its "Show in Control
// room", opens the Control room on that card, brought into sight and marked as from the other surfaces (#962).

import { NotificationGestureResult } from "../notifications-store";

// must match ReviewsCardGesture in pkg/molten/mission/reviews_card.go
export const ReviewsCardGesture = "reviews:card";

export async function reviewsCardGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const dir = typeof args?.dir === "string" ? args.dir : "";
    const number = typeof args?.number === "number" ? args.number : 0;
    // Loaded on the click: the Reviews store reaches the agent choice, which hosts this gesture.
    const { ReviewsModel } = await import("./reviews-store");
    await ReviewsModel.getInstance().openReviews(dir, number > 0 ? number : undefined);
    return { ok: true };
}
