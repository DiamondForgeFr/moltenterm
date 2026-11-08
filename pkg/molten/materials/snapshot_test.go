// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestMaterialSnapshotsOwnNestedData(t *testing.T) {
	readers := map[string]func(*Store, molten.Material) (molten.Material, error){
		"get": func(s *Store, m molten.Material) (molten.Material, error) {
			return s.Get(m.Project, m.Id)
		},
		"list": func(s *Store, m molten.Material) (molten.Material, error) {
			list, err := s.List(m.Project)
			if err != nil {
				return molten.Material{}, err
			}
			return list[0], nil
		},
		"match": func(s *Store, m molten.Material) (molten.Material, error) {
			found, ok := s.match(m.Project, "", "", m.Original)
			if !ok {
				return molten.Material{}, fmt.Errorf("material not matched")
			}
			return found, nil
		},
		"update": func(s *Store, m molten.Material) (molten.Material, error) {
			return s.Pin(m.Project, m.Id, true)
		},
		"update-noop": func(s *Store, m molten.Material) (molten.Material, error) {
			return s.Pin(m.Project, m.Id, false)
		},
		"commit": func(s *Store, m molten.Material) (molten.Material, error) {
			m.Title = "new title"
			out, changed, err := s.commit(m.Project, "", m.Id, m, nil, commitOpts{toolTitle: true}, DefaultLimits())
			if err == nil && !changed {
				err = fmt.Errorf("commit did not change the title")
			}
			return out, err
		},
		"commit-noop": func(s *Store, m molten.Material) (molten.Material, error) {
			out, changed, err := s.commit(m.Project, "", m.Id, m, nil, commitOpts{}, DefaultLimits())
			if err == nil && changed {
				err = fmt.Errorf("unchanged commit wrote the material")
			}
			return out, err
		},
		"restore": func(s *Store, m molten.Material) (molten.Material, error) {
			trash, err := s.DeleteCopy(m.Project, m.Id)
			if err != nil {
				return molten.Material{}, err
			}
			return s.Restore(m.Project, trash)
		},
	}
	for name, read := range readers {
		t.Run(name, func(t *testing.T) {
			h := makeHarness(t)
			m, err := h.r.Add("block-1", "", h.write("page.txt", "initial"), "", "", false, molten.MaterialSourceDeclared)
			if err != nil {
				t.Fatal(err)
			}
			m, err = h.r.store.Opened(m.Project, m.Id, molten.MaterialPlace{WorkspaceId: "ws-1", TabId: "tab-1", View: "original view"})
			if err != nil {
				t.Fatal(err)
			}
			out, err := read(h.r.store, m)
			if err != nil {
				t.Fatal(err)
			}
			out.Versions[0].Hash = "caller mutation"
			out.LastOpened.View = "caller mutation"
			stored, err := h.r.store.Get(m.Project, m.Id)
			if err != nil {
				t.Fatal(err)
			}
			if stored.Versions[0].Hash != m.Versions[0].Hash || stored.LastOpened.View != "original view" {
				t.Fatalf("returned snapshot changed the index: %+v", stored)
			}
		})
	}
}

func TestMaterialSnapshotPrecedesChangeNotification(t *testing.T) {
	for _, action := range []string{"update", "commit", "restore"} {
		t.Run(action, func(t *testing.T) {
			h := makeHarness(t)
			m, err := h.r.Add("block-1", "", h.write("page.txt", "initial"), "", "", false, molten.MaterialSourceDeclared)
			if err != nil {
				t.Fatal(err)
			}
			var trash string
			if action == "restore" {
				trash, err = h.r.store.DeleteCopy(m.Project, m.Id)
				if err != nil {
					t.Fatal(err)
				}
			}
			h.r.store.SetOnChange(func(molten.MaterialsChanged) {
				h.r.store.SetOnChange(nil)
				tmp, err := h.r.store.reserveVersion(m.Project)
				if err != nil {
					t.Fatal(err)
				}
				defer h.r.store.releaseVersion(tmp)
				if err := os.WriteFile(filepath.Join(tmp, "page.txt"), []byte("updated"), fileMode); err != nil {
					t.Fatal(err)
				}
				ver := &pendingVersion{tmp: tmp, hash: "notification-recopy", size: 7, main: "page.txt"}
				if _, _, err := h.r.store.commit(m.Project, "", m.Id, m, ver, commitOpts{recopy: true}, h.r.limits); err != nil {
					t.Fatal(err)
				}
			})
			var out molten.Material
			switch action {
			case "update":
				out, err = h.r.store.Pin(m.Project, m.Id, true)
			case "commit":
				m.Title = "new title"
				out, _, err = h.r.store.commit(m.Project, "", m.Id, m, nil, commitOpts{toolTitle: true}, h.r.limits)
			case "restore":
				out, err = h.r.store.Restore(m.Project, trash)
			}
			if err != nil {
				t.Fatal(err)
			}
			if out.Versions[0].Hash != m.Versions[0].Hash {
				t.Fatalf("a later recopy changed the completed operation's snapshot: %+v", out)
			}
			current, err := h.r.store.Get(m.Project, m.Id)
			if err != nil || current.Versions[0].Hash != "notification-recopy" {
				t.Fatalf("notification did not recopy the material: %+v, %v", current, err)
			}
		})
	}
}

func TestMaterialSnapshotsDuringRecopy(t *testing.T) {
	h := makeHarness(t)
	m, err := h.r.Add("block-1", "", h.write("page.txt", "initial"), "", "", false, molten.MaterialSourceDeclared)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		for i := 0; i < 1000; i++ {
			got, err := h.r.store.Get(m.Project, m.Id)
			if err != nil {
				t.Error(err)
				return
			}
			list, err := h.r.store.List(m.Project)
			if err != nil {
				t.Error(err)
				return
			}
			matched, ok := h.r.store.match(m.Project, "", "", m.Original)
			if !ok {
				t.Error("material not matched")
				return
			}
			updated, err := h.r.store.Pin(m.Project, m.Id, false)
			if err != nil {
				t.Error(err)
				return
			}
			committed, _, err := h.r.store.commit(m.Project, "", m.Id, m, nil, commitOpts{}, h.r.limits)
			if err != nil {
				t.Error(err)
				return
			}
			for _, snapshot := range []molten.Material{got, list[0], matched, updated, committed} {
				if len(snapshot.Versions) != 1 || snapshot.Versions[0].N != 1 || snapshot.Versions[0].Main != "page.txt" {
					t.Errorf("recopy returned an inconsistent version: %+v", snapshot)
					return
				}
			}
		}
	}()
	go func() {
		defer workers.Done()
		<-start
		for i := 0; i < 100; i++ {
			tmp, err := h.r.store.reserveVersion(m.Project)
			if err != nil {
				t.Error(err)
				return
			}
			if err := os.WriteFile(filepath.Join(tmp, "page.txt"), []byte("updated"), fileMode); err != nil {
				h.r.store.releaseVersion(tmp)
				t.Error(err)
				return
			}
			ver := &pendingVersion{tmp: tmp, hash: fmt.Sprintf("recopy-%d", i), size: 7, main: "page.txt"}
			out, changed, err := h.r.store.commit(m.Project, "", m.Id, m, ver, commitOpts{recopy: true}, h.r.limits)
			h.r.store.releaseVersion(tmp)
			if err != nil {
				t.Error(err)
				return
			}
			if !changed || len(out.Versions) != 1 || out.Versions[0].Hash != ver.hash {
				t.Errorf("recopy did not replace the current version: %+v", out)
				return
			}
		}
	}()
	close(start)
	workers.Wait()
}
