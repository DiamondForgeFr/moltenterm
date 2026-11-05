// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func BenchmarkMaterialsScope(b *testing.B) {
	root := b.TempDir()
	original := filepath.Join(root, "original.txt")
	if err := os.WriteFile(original, []byte("fixture"), 0o600); err != nil {
		b.Fatal(err)
	}
	store := MakeStore(filepath.Join(root, "store"))
	store.scanned = true
	var first string
	for project := 0; project < 10; project++ {
		folder := filepath.Join(root, fmt.Sprintf("project-%d", project))
		key, _ := ProjectKey(folder)
		if first == "" {
			first = key
		}
		d := &drawer{key: key, folder: folder, loaded: true, written: true}
		for item := 0; item < 100; item++ {
			d.index.Materials = append(d.index.Materials, molten.Material{
				Id: fmt.Sprintf("%016x", project*100+item), Project: key, Title: "fixture material",
				Original: original, OriginalName: "original.txt", Kind: "file", Updated: int64(item),
				Versions: []molten.MaterialVersion{{N: 1, Size: 7, Dir: "v1", Main: "original.txt", Hash: "fixture"}},
			})
		}
		store.drawers[key] = d
	}
	registry := MakeRegistry(store, root, nil)
	for _, all := range []bool{true, false} {
		name := "active-and-summaries"
		if all {
			name = "all-records"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			var rows, size int
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				view, err := registry.View(first, all)
				if err != nil {
					b.Fatal(err)
				}
				data, err := json.Marshal(view)
				if err != nil {
					b.Fatal(err)
				}
				rows, size = len(view.Materials), len(data)
				if !all {
					summary, err := json.Marshal(molten.MaterialsView{Projects: store.Projects()})
					if err != nil {
						b.Fatal(err)
					}
					size += len(summary)
				}
			}
			b.ReportMetric(float64(rows), "rows/op")
			b.ReportMetric(float64(size), "json-B/op")
		})
	}
}
