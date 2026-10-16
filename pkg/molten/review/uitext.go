// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The review service's errors that several commands share. Each carries its code for the Review tab (#656, the
// sentences live under server.review.* in the window's locales); the English stays for `molten review` and the logs.

func noCommentError(id string) error {
	return uimsg.Errorf(uimsg.Make("review.nocomment"), "no comment has the id %s", id)
}

// lockedError: a comment that is not editable is published or dropped.
func lockedError(c *Comment) error {
	if c.State == CommentStateDropped {
		return uimsg.Errorf(uimsg.Make("review.commentdropped"), "this comment is %s: it cannot be changed", c.State)
	}
	return uimsg.Errorf(uimsg.Make("review.commentpublished"), "this comment is %s: it cannot be changed", c.State)
}

func noSessionError() error {
	return uimsg.Errorf(uimsg.Make("review.nosession"), "MoltenTerm cannot reach the review session")
}

func noGhError() error {
	return uimsg.Errorf(uimsg.Make("review.nogh"), "gh is not available")
}

func pathOutsideError() error {
	return uimsg.Errorf(uimsg.Make("review.pathoutside"), "the path must stay in the project")
}

func rebaseUnavailableError() error {
	return uimsg.Errorf(uimsg.Make("review.rebaseunavailable"), "Ask for a rebase is not available")
}
