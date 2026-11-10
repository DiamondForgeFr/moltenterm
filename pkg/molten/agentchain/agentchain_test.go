// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentchain

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func record(t *testing.T, r *Registry, lead string, sub string) {
	t.Helper()
	if _, err := r.Record(lead, sub, "", "", ViaHandoff); err != nil {
		t.Fatalf("Record(%s, %s): %v", lead, sub, err)
	}
}

func TestSubsAtAnyDepth(t *testing.T) {
	t.Parallel()
	r := Open("")
	record(t, r, "Flore", "Hugo")
	record(t, r, "Hugo", "Léa")
	record(t, r, "Léa", "Marc")
	record(t, r, "Jérôme", "Zoé")
	got := Subs(r.Edges(), "flore")
	if want := []string{"Hugo", "Léa", "Marc"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sub-agents of Flore = %v, want %v", got, want)
	}
	got = Subs(r.Edges(), "Flore", "Jerome")
	if want := []string{"Hugo", "Zoé", "Léa", "Marc"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("union of Flore and Jerome = %v, want %v", got, want)
	}
	if got := Subs(r.Edges(), "Marc"); len(got) != 0 {
		t.Fatalf("a sub-agent without sub-agents of its own has %v", got)
	}
}

func TestRecordRefusesLoopsAndSelf(t *testing.T) {
	t.Parallel()
	r := Open("")
	record(t, r, "Flore", "Hugo")
	record(t, r, "Hugo", "Léa")
	if _, err := r.Record("Léa", "Flore", "", "", ViaHandoff); err == nil {
		t.Fatal("Léa leading Flore would close a loop")
	}
	if _, err := r.Record("Flore", "flore", "", "", ViaHandoff); err == nil {
		t.Fatal("an agent cannot lead itself")
	}
	if _, err := r.Record("", "Hugo", "", "", ViaHandoff); err == nil {
		t.Fatal("a link names both agents")
	}
	if got := len(r.Edges()); got != 2 {
		t.Fatalf("%d links after the refusals, want 2", got)
	}
}

func TestRecordTwiceIsOneLink(t *testing.T) {
	t.Parallel()
	r := Open("")
	changed, err := r.Record("Flore", "Hugo", "b1", "b2", ViaHandoff)
	if err != nil || !changed {
		t.Fatalf("first record: changed=%v err=%v", changed, err)
	}
	changed, err = r.Record("flore", "HUGO", "b1", "b2", ViaHandoff)
	if err != nil || changed {
		t.Fatalf("second record: changed=%v err=%v", changed, err)
	}
	if got := len(r.Edges()); got != 1 {
		t.Fatalf("%d links, want 1", got)
	}
}

func TestLinksSurviveARestart(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "molten", FileName)
	first := Open(path)
	record(t, first, "Flore", "Hugo")
	record(t, first, "Hugo", "Léa")
	second := Open(path)
	got := second.Edges()
	if len(got) != 2 || got[0].Lead != "Flore" || got[0].Sub != "Hugo" || got[1].Lead != "Hugo" || got[1].Sub != "Léa" {
		t.Fatalf("links read back = %+v", got)
	}
	if subs := Subs(got, "Flore"); !reflect.DeepEqual(subs, []string{"Hugo", "Léa"}) {
		t.Fatalf("sub-agents of Flore after a restart = %v", subs)
	}
}

func TestUnreadableFileIsAnEmptyChain(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	r := Open(path)
	if got := r.Edges(); len(got) != 0 {
		t.Fatalf("links of an unreadable file = %+v", got)
	}
	record(t, r, "Flore", "Hugo")
	if got := Open(path).Edges(); len(got) != 1 {
		t.Fatalf("the file is rewritten whole, links read back = %+v", got)
	}
}

func TestNameHeldByAnotherTerminalDoesNotInheritTheLink(t *testing.T) {
	t.Parallel()
	r := Open("")
	if _, err := r.Record("Flore", "Hugo", "lead1", "old", ViaHandoff); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record("Jérôme", "Hugo", "lead2", "new", ViaHandoff); err != nil {
		t.Fatal(err)
	}
	got := r.Edges()
	if len(got) != 1 || got[0].Lead != "Jérôme" {
		t.Fatalf("a new holder of Hugo keeps Flore's link: %+v", got)
	}
	if lead := LeadOf(got, "hugo"); lead != "Jérôme" {
		t.Fatalf("lead of Hugo = %q", lead)
	}
}

func TestOldLinksExpire(t *testing.T) {
	t.Parallel()
	r := Open("")
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	record(t, r, "Flore", "Hugo")
	r.now = func() time.Time { return now.Add(maxEdgeAge + time.Hour) }
	if got := r.Edges(); len(got) != 0 {
		t.Fatalf("a link older than %v is still there: %+v", maxEdgeAge, got)
	}
}

func TestLeadOfIsTheLastToDelegate(t *testing.T) {
	t.Parallel()
	r := Open("")
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	record(t, r, "Flore", "Hugo")
	r.now = func() time.Time { return now.Add(time.Minute) }
	record(t, r, "Léa", "Hugo")
	if lead := LeadOf(r.Edges(), "Hugo"); lead != "Léa" {
		t.Fatalf("lead of Hugo = %q, want Léa", lead)
	}
	if lead := LeadOf(r.Edges(), "Flore"); lead != "" {
		t.Fatalf("lead of Flore = %q, want none", lead)
	}
}
