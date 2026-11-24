// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package contextpins

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func pin(id string) map[string]any {
	return map[string]any{"id": id, "name": id, "rev": float64(1)}
}

func TestEachContextHasItsOwnKey(t *testing.T) {
	if MetaKey("a") == MetaKey("b") {
		t.Fatalf("two contexts share the key %q", MetaKey("a"))
	}
	meta := waveobj.MetaMapType{MetaKey("a"): []any{pin("g1")}, MetaKey("b"): []any{}}
	if !Has(meta, "a") || !Has(meta, "b") || Has(meta, "c") {
		t.Fatalf("Has: a, b and not c expected in %v", meta)
	}
	if got := PinsOf(meta, "a"); len(got) != 1 {
		t.Fatalf("a's row = %v, want its one pin", got)
	}
	if got := PinsOf(meta, "b"); len(got) != 0 {
		t.Fatalf("b's row = %v, want none", got)
	}
	if got := PinsOf(meta, "c"); got != nil {
		t.Fatalf("c holds no row, got %v", got)
	}
}

func TestAnEmptyRowIsARowOfItsOwn(t *testing.T) {
	meta := waveobj.MetaMapType{MetaKey("a"): []any{}}
	if !Has(meta, "a") {
		t.Fatalf("a context whose row was emptied still holds one")
	}
}

func TestMigrationCopiesTheFormerRowIntoEveryContext(t *testing.T) {
	meta := waveobj.MetaMapType{LegacyMetaKey: []any{pin("g1"), pin("g2")}}
	patch := Migration(meta, []string{"workshop", "client"})
	if patch == nil {
		t.Fatal("the former row was not migrated")
	}
	for _, id := range []string{"workshop", "client"} {
		row, _ := patch[MetaKey(id)].([]any)
		if len(row) != 2 {
			t.Fatalf("%s got %v, want the two pins", id, patch[MetaKey(id)])
		}
	}
	if v, ok := patch[LegacyMetaKey]; !ok || v != nil {
		t.Fatalf("the former row must be dropped, patch = %v", patch)
	}
	if patch[MigratedMetaKey] != true {
		t.Fatalf("the client must be marked, patch = %v", patch)
	}
}

func TestMigrationGivesEachContextACopyOfItsOwn(t *testing.T) {
	meta := waveobj.MetaMapType{LegacyMetaKey: []any{pin("g1")}}
	patch := Migration(meta, []string{"a", "b"})
	a := patch[MetaKey("a")].([]any)
	b := patch[MetaKey("b")].([]any)
	a[0].(map[string]any)["name"] = "renamed in a"
	if b[0].(map[string]any)["name"] != "g1" {
		t.Fatalf("a rename in a reached b: %v", b)
	}
}

func TestMigrationRunsExactlyOnce(t *testing.T) {
	meta := waveobj.MetaMapType{LegacyMetaKey: []any{pin("g1")}}
	patch := Migration(meta, []string{"a"})
	after := waveobj.MergeMeta(meta, patch, false)
	if _, ok := after[LegacyMetaKey]; ok {
		t.Fatalf("the former row stayed: %v", after)
	}
	if again := Migration(after, []string{"a", "later"}); again != nil {
		t.Fatalf("a second start migrated again: %v", again)
	}
	if got := PinsOf(after, "a"); len(got) != 1 {
		t.Fatalf("a keeps its row, got %v", got)
	}
}

func TestMigrationOfAnEmptyRowStillGivesEveryContextItsOwn(t *testing.T) {
	patch := Migration(waveobj.MetaMapType{}, []string{"a", "b"})
	meta := waveobj.MergeMeta(waveobj.MetaMapType{}, patch, false)
	if !Has(meta, "a") || !Has(meta, "b") {
		t.Fatalf("both contexts hold an (empty) row of their own: %v", meta)
	}
	if !Migrated(meta) {
		t.Fatalf("the client is marked: %v", meta)
	}
}

func TestADeletedContextTakesItsRowWithIt(t *testing.T) {
	meta := waveobj.MetaMapType{
		MetaKey("a"):       []any{pin("g1")},
		MetaKey("deleted"): []any{pin("g2")},
		MigratedMetaKey:    true,
		"molten:contexts":  []any{},
	}
	got := Orphans(meta, []string{"a", "b"})
	if len(got) != 1 || got[0] != MetaKey("deleted") {
		t.Fatalf("orphans = %v, want only the deleted context's key", got)
	}
}

func TestMigrationKeepsARowAContextAlreadyHolds(t *testing.T) {
	meta := waveobj.MetaMapType{
		LegacyMetaKey: []any{pin("g1")},
		MetaKey("a"):  []any{pin("own")},
	}
	patch := Migration(meta, []string{"a", "b"})
	if _, ok := patch[MetaKey("a")]; ok {
		t.Fatalf("a's own row was overwritten: %v", patch)
	}
	if !reflect.DeepEqual(patch[MetaKey("b")], []any{pin("g1")}) {
		t.Fatalf("b = %v, want the former row", patch[MetaKey("b")])
	}
}
