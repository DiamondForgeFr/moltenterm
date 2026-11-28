// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"strings"
)

// ReleaseBeingPrepared is the title of the oldest open milestone whose title is a version, the release the project is
// preparing (the first tab of the companion, order.go), for a ticket that belongs in it; "" when the project has none or
// the forge cannot be read: a ticket without a milestone is better than none. It reads the project's forge through gh in
// dir, the one the project's other calls use.
func ReleaseBeingPrepared(ctx context.Context, gh func(ctx context.Context, dir string, args ...string) ([]byte, error), dir string) string {
	list, err := openMilestones(ctx, gh, dir)
	if err != nil {
		return ""
	}
	return oldestVersionMilestone(list)
}

func oldestVersionMilestone(list []forgeMilestone) string {
	for _, milestone := range orderMilestones(list) {
		if parseVersion(milestone.Title).ok {
			return strings.TrimSpace(milestone.Title)
		}
	}
	return ""
}
