// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"reflect"
	"slices"
	"testing"
)

func TestWithoutProjectDropsThatProjectsPlaceAndFoldersOnly(t *testing.T) {
	t.Parallel()
	before := fixture(t)
	got, changed := WithoutProject(before, "ws-a", "p1")
	if !changed {
		t.Fatal("ws-a/p1 had places")
	}
	// b-1 and b-2 sit at other places too and stay; nothing of ws-b/p1 or ws-a/p2 moves.
	if want := []string{"b-1", "b-2", "b-3", "b-4", "b-5", "b-6", "b-7"}; !reflect.DeepEqual(recordIds(got), want) {
		t.Fatalf("records %v, want %v", recordIds(got), want)
	}
	if !reflect.DeepEqual(got.Records[0].Places, []Place{{Level: LevelApp}}) || !reflect.DeepEqual(got.Records[1].Places, []Place{{Level: LevelContext, Id: "ctx-client", Folder: "f-ops"}}) {
		t.Errorf("places left: %+v %+v", got.Records[0].Places, got.Records[1].Places)
	}
	if _, has := got.Folders["project:ws-a/p1"]; has {
		t.Error("the project's folders stayed")
	}
	if len(got.Folders["project:ws-b/p1"]) != 1 || len(got.Folders["context:ctx-client"]) != 1 {
		t.Errorf("another place's folders went: %+v", got.Folders)
	}
	if len(before.Records[0].Places) != 2 || len(before.Folders["project:ws-a/p1"]) != 2 {
		t.Error("the store it was given was changed")
	}
}

// A record that has no place left shows nowhere, so it goes; a project id that is reused (the next free pN) must not
// inherit what the removed one held.
func TestWithoutProjectDeletesTheRecordsLeftWithNoPlace(t *testing.T) {
	t.Parallel()
	got, changed := WithoutProject(fixture(t), "ws-a", "p2")
	if !changed || len(got.Records) != 6 {
		t.Fatalf("changed %v, records %v", changed, recordIds(got))
	}
	for _, r := range got.Records {
		if r.Id == "b-6" {
			t.Error("b-6 sat only in ws-a/p2 and stayed")
		}
	}
	if visible := VisibleFrom(got, Here{ContextId: "ctx-client", WorkspaceId: "ws-a", ProjectId: "p2"}, Names{}); slices.Contains(titles(visible), "Site") {
		t.Errorf("a new p2 inherited %v", titles(visible))
	}
}

func TestWithoutProjectChangesNothingWhenThereIsNoSuchPlace(t *testing.T) {
	t.Parallel()
	before := fixture(t)
	got, changed := WithoutProject(before, "ws-a", "p9")
	if changed || !reflect.DeepEqual(got, before) {
		t.Errorf("changed %v", changed)
	}
	if _, changed := WithoutProject(Store{}, "ws-a", "p1"); changed {
		t.Error("an empty store has nothing to drop")
	}
}

func TestWithoutWorkspaceDropsItsPlaceAndItsProjectsAndNotAWorkspaceWhoseIdStartsTheSame(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{
	  "records": [
	    {"id": "a", "url": "https://a.example.com/", "places": [{"level": "workspace", "id": "ws-a"}, {"level": "app"}]},
	    {"id": "b", "url": "https://b.example.com/", "places": [{"level": "project", "id": "ws-a/p1"}, {"level": "project", "id": "ws-a/p2"}]},
	    {"id": "c", "url": "https://c.example.com/", "places": [{"level": "workspace", "id": "ws-ab"}, {"level": "project", "id": "ws-ab/p1"}]},
	    {"id": "d", "url": "https://d.example.com/", "places": [{"level": "context", "id": "ws-a"}]}
	  ],
	  "folders": {"workspace:ws-a": [{"id": "f", "name": "F"}], "project:ws-a/p1": [{"id": "g", "name": "G"}], "workspace:ws-ab": [{"id": "h", "name": "H"}], "context:ws-a": [{"id": "i", "name": "I"}]}
	}`)
	got, changed := WithoutWorkspace(ReadStore(meta), "ws-a")
	if !changed {
		t.Fatal("ws-a had places")
	}
	if want := []string{"a", "c", "d"}; !reflect.DeepEqual(recordIds(got), want) {
		t.Fatalf("records %v, want %v", recordIds(got), want)
	}
	if !reflect.DeepEqual(got.Records[0].Places, []Place{{Level: LevelApp}}) || len(got.Records[1].Places) != 2 || got.Records[2].Places[0].Level != LevelContext {
		t.Errorf("places %+v", got.Records)
	}
	if want := []string{"context:ws-a", "workspace:ws-ab"}; len(got.Folders) != 2 || len(got.Folders[want[0]]) != 1 || len(got.Folders[want[1]]) != 1 {
		t.Errorf("folders %+v, want only %v", got.Folders, want)
	}
}

func TestWithoutContextDropsItsPlaceAndFoldersOnly(t *testing.T) {
	t.Parallel()
	got, changed := WithoutContext(fixture(t), "ctx-perso")
	if !changed {
		t.Fatal("ctx-perso had places")
	}
	if want := []string{"b-1", "b-2", "b-3", "b-4", "b-6", "b-7"}; !reflect.DeepEqual(recordIds(got), want) {
		t.Fatalf("records %v, want %v (b-5 sat only there)", recordIds(got), want)
	}
	if _, has := got.Folders["context:ctx-perso"]; has || len(got.Folders["context:ctx-client"]) != 1 {
		t.Errorf("folders %+v", got.Folders)
	}
	for _, p := range got.Records[len(got.Records)-1].Places {
		if p.Level == LevelContext {
			t.Errorf("b-7 kept its place of the deleted context: %+v", got.Records[len(got.Records)-1].Places)
		}
	}
	if _, changed := WithoutContext(fixture(t), "ctx-none"); changed {
		t.Error("a context without places changes nothing")
	}
}

func TestADroppedStoreWithNothingLeftHasNoValue(t *testing.T) {
	t.Parallel()
	only := ReadStore(clientMeta(t, `{"records": [{"id": "a", "url": "https://a.example.com/", "places": [{"level": "project", "id": "w/p1"}]}], "folders": {"project:w/p1": [{"id": "f", "name": "F"}]}}`))
	got, changed := WithoutProject(only, "w", "p1")
	if !changed || got.MetaValue() != nil {
		t.Errorf("the last record and folder go and the key with them: %v %v", got.MetaValue(), changed)
	}
}

// Deleting a workspace can be undone for a few seconds under the same id: what sat at its places comes back, and what
// sat elsewhere too is not duplicated.
func TestRestoreGivesBackWhatAWorkspaceHad(t *testing.T) {
	t.Parallel()
	before := fixture(t)
	part := WorkspacePart(before, "ws-a")
	if want := []string{"b-1", "b-2", "b-3", "b-6"}; !reflect.DeepEqual(recordIds(part), want) {
		t.Fatalf("part %v, want %v", recordIds(part), want)
	}
	if got := part.Records[0].Places; !reflect.DeepEqual(got, []Place{{Level: LevelProject, Id: "ws-a/p1", Folder: "f-docs"}}) {
		t.Errorf("the part keeps the places of the workspace only: %+v", got)
	}
	if len(part.Folders) != 2 || len(part.Folders["workspace:ws-a"]) != 1 || len(part.Folders["project:ws-a/p1"]) != 2 {
		t.Errorf("folders %+v", part.Folders)
	}
	deleted, _ := WithoutWorkspace(before, "ws-a")
	restored := Restore(deleted, part)
	want := VisibleFrom(before, hereInP1, namesOfA)
	if got := VisibleFrom(restored, hereInP1, namesOfA); !reflect.DeepEqual(got, want) {
		t.Errorf("after undo:\n%v\nbefore:\n%v", shapes(got), shapes(want))
	}
	if again := Restore(restored, part); !reflect.DeepEqual(shapes(VisibleFrom(again, hereInP1, namesOfA)), shapes(want)) || len(again.Records) != len(restored.Records) {
		t.Error("restoring twice duplicated what was there")
	}
	if len(WorkspacePart(before, "ws-none").Records) != 0 {
		t.Error("a workspace without bookmarks has an empty part")
	}
}
