// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

const testHead = "0123456789abcdef0123456789abcdef01234567"

// FR-REV-005 AC4: the session's briefing is kept in the review store, the latest in place of the previous one, and
// read again when the PR is reopened; other posts are not kept here.
func TestSessionBriefingKept(t *testing.T) {
	dir := t.TempDir()
	var published []State
	svc := MakeService(dir, nil, func(k PrKey, state State) { published = append(published, state) })
	post := func(kind string, markdown string, at int64) {
		svc.SessionPosted(mcpreview.Update{Repo: "Owner/Repo", Number: 7, Post: &mcpreview.Post{
			Id: "e1", Kind: kind, Markdown: markdown, HeadOid: testHead, Agent: "claude", At: at}})
	}
	post(mcpreview.PostExplanation, "an explanation", 1)
	if len(published) != 0 {
		t.Fatalf("an explanation was kept: %+v", published)
	}
	post(mcpreview.PostBriefing, "## What changed\nfirst", 2)
	post(mcpreview.PostBriefing, "## What changed\nsecond", 3)
	post(mcpreview.PostBriefing, "## What changed\nsecond", 3)
	if len(published) != 2 {
		t.Fatalf("%d store updates", len(published))
	}
	reopened, err := MakeStore(dir).Get(PrKey{Repo: "Owner/Repo", Number: 7})
	if err != nil || reopened.Briefing == nil || !strings.HasSuffix(reopened.Briefing.Markdown, "second") ||
		reopened.Briefing.HeadOid != testHead || reopened.Briefing.Agent != "claude" || reopened.Briefing.At != 3 {
		t.Fatalf("reopened %+v: %v", reopened.Briefing, err)
	}
	if _, _, err := svc.store.SetBriefing(PrKey{Repo: "Owner/Repo", Number: 7}, Briefing{Markdown: " "}); err == nil {
		t.Error("an empty briefing was kept")
	}
	if _, _, err := svc.store.SetBriefing(PrKey{Repo: "Owner/Repo", Number: 7}, Briefing{Markdown: "x", HeadOid: "--evil"}); err == nil {
		t.Error("a bad head was kept")
	}
	svc.SessionPosted(mcpreview.Update{Repo: "../x", Number: 7, Post: &mcpreview.Post{Kind: mcpreview.PostBriefing, Markdown: "x"}})
	if len(published) != 2 {
		t.Error("a post of a bad repository was kept")
	}
}
