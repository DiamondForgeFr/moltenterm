// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"strings"
	"testing"
)

func TestLinkNoticeTellsTheDeveloperOnTheAgentsPane(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	if err := m.LinkNotice(context.Background(), LinkNoticeRequest{Token: "tokA", Server: "molten-browser", Failed: 3}); err != nil {
		t.Fatal(err)
	}
	notes := env.notifications()
	if len(notes) != 1 {
		t.Fatalf("notifications: %+v", notes)
	}
	n := notes[0]
	if n.Key != LinkNoticeKeyPrefix+"blockA" || n.BlockId != "blockA" || n.WorkspaceId != "wsA" || n.Kind != "warning" {
		t.Fatalf("notification: %+v", n)
	}
	if n.Title != "Camille lost its link to MoltenTerm" || n.TitleText.Code != "agentlink.restored.title" {
		t.Fatalf("title: %q %+v", n.Title, n.TitleText)
	}
	if !strings.HasPrefix(n.Message, "3 calls failed") || n.MessageText.Code != "agentlink.restored.messageother" ||
		n.MessageText.Vars["count"] != "3" || n.MessageText.Vars["name"] != "Camille" {
		t.Fatalf("message: %q %+v", n.Message, n.MessageText)
	}
	if len(n.Actions) != 1 || n.Actions[0].Kind != "open" || n.Actions[0].BlockId != "blockA" || n.Actions[0].Label != "Go to Camille" {
		t.Fatalf("actions: %+v", n.Actions)
	}

	if err := m.LinkNotice(context.Background(), LinkNoticeRequest{Token: "tokB", Server: "molten-browser", Failed: 1}); err != nil {
		t.Fatal(err)
	}
	if one := env.notifications()[1]; one.MessageText.Code != "agentlink.restored.messageone" || !strings.HasPrefix(one.Message, "1 call failed") {
		t.Fatalf("one failed call: %+v", one)
	}
}

func TestLinkNoticeTrustsOnlyAValidToken(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	if err := m.LinkNotice(context.Background(), LinkNoticeRequest{Token: "forged", Failed: 2}); err == nil || err.Error() != errNotInMoltenTerm {
		t.Fatalf("forged token: %v", err)
	}
	if err := m.LinkNotice(context.Background(), LinkNoticeRequest{Token: "tokA", Failed: 0}); err != nil {
		t.Fatal(err)
	}
	if notes := env.notifications(); len(notes) != 0 {
		t.Fatalf("nothing failed, nothing to say: %+v", notes)
	}
}
