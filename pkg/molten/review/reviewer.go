// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// The developer's first name on a validated PR (#847): the review:reviewername setting, else the first word of the
// project's git user.name. Empty when neither is set; the merge then names the PR's author.

const reviewerGitTimeout = 5 * time.Second

func firstWord(name string) string {
	fields := strings.Fields(name)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func reviewerNameOf(setting string, gitUserName func() string) string {
	if name := strings.TrimSpace(setting); name != "" {
		return name
	}
	if gitUserName == nil {
		return ""
	}
	return firstWord(gitUserName())
}

func gitUserName(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), reviewerGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "config", "user.name")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ReviewerName is the first name the "Reviewed by" line carries.
func ReviewerName(dir string) string {
	setting := wconfig.GetWatcher().GetFullConfig().Settings.ReviewReviewerName
	return reviewerNameOf(setting, func() string { return gitUserName(dir) })
}
