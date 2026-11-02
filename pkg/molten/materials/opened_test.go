// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #1546: the card says where a material lives; the registry remembers the last view it was open in.
func TestOpenedRemembersThePlace(t *testing.T) {
	h := makeHarness(t)
	now := time.Now()
	h.r.store.now = func() time.Time { return now }
	m, err := h.r.Add("block-1", "", h.write("plan.md", "# Plan"), "", "", false, molten.MaterialSourceDeclared)
	if err != nil {
		t.Fatal(err)
	}
	if m.LastOpened != nil {
		t.Fatalf("a new material was never open: %+v", m.LastOpened)
	}
	var changes int
	h.r.store.SetOnChange(func(molten.MaterialsChanged) { changes++ })
	h.r.store.now = func() time.Time { return now.Add(time.Minute) }
	place := molten.MaterialPlace{WorkspaceId: "ws-1", Workspace: "MoltenTerm", TabId: "tab-1", View: "Cadrage"}
	got, err := h.r.store.Opened("", m.Id, place)
	if err != nil {
		t.Fatal(err)
	}
	if got.LastOpened == nil || got.LastOpened.View != "Cadrage" || got.LastOpened.Workspace != "MoltenTerm" || got.LastOpened.At != now.Add(time.Minute).UnixMilli() {
		t.Fatalf("place not kept: %+v", got.LastOpened)
	}
	if got.Updated != m.Updated {
		t.Errorf("seeing a material open must not move its updated time")
	}
	if changes != 1 {
		t.Errorf("one change published, got %d", changes)
	}
	if _, err := h.r.store.Opened("", m.Id, place); err != nil || changes != 1 {
		t.Errorf("the same view seen again writes nothing (changes %d, err %v)", changes, err)
	}
	place.View = "Review"
	if got, _ := h.r.store.Opened("", m.Id, place); got.LastOpened.View != "Review" || changes != 2 {
		t.Errorf("another view replaces the place: %+v, changes %d", got.LastOpened, changes)
	}
	place.View = "Review"
	h.r.store.now = func() time.Time { return now.Add(2 * time.Hour) }
	if got, _ := h.r.store.Opened("", m.Id, place); got.LastOpened.At != now.Add(2*time.Hour).UnixMilli() || changes != 3 {
		t.Errorf("the same view seen much later refreshes the time: %+v", got.LastOpened)
	}
	if list := h.list(); list[0].LastOpened == nil || list[0].LastOpened.View != "Review" {
		t.Errorf("the list carries the place: %+v", list[0].LastOpened)
	}
	if _, err := h.r.store.Opened("", m.Id, molten.MaterialPlace{WorkspaceId: "ws-1"}); err == nil {
		t.Errorf("a place without its view is refused")
	}
}

func TestListGivesTheThumbPath(t *testing.T) {
	h := makeHarness(t)
	m, err := h.r.Add("block-1", "", h.writePng("shot.png", 800, 400), "", "", false, molten.MaterialSourceDeclared)
	if err != nil {
		t.Fatal(err)
	}
	list := h.list()
	if len(list) != 1 || list[0].Id != m.Id || !list[0].Thumb || list[0].ThumbPath == "" {
		t.Fatalf("an image lists its preview: %+v", list)
	}
	if _, err := os.Stat(list[0].ThumbPath); err != nil {
		t.Errorf("the preview is on disk: %v", err)
	}
}
