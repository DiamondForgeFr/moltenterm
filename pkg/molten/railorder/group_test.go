// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"slices"
	"testing"
)

// Rail: s (solo), n1 n2 (product n), x, w1 w2 w3 (product w).
var groupedOrder = []string{"s", "n1", "n2", "x", "w1", "w2", "w3"}
var groupedProducts = map[string]string{"n1": "n", "n2": "n", "w1": "w", "w2": "w", "w3": "w"}

func block(workspaceId string, targetId string, place string) MoveRequest {
	req := mv(workspaceId, targetId, place)
	req.Block = true
	return req
}

func TestNormalize(t *testing.T) {
	got := Normalize([]string{"n1", "s", "w1", "n2", "x", "w2"}, map[string]string{"n1": "n", "n2": "n", "w1": "w", "w2": "w"})
	if want := []string{"n1", "n2", "s", "w1", "w2", "x"}; !slices.Equal(got, want) {
		t.Fatalf("Normalize = %v; want %v", got, want)
	}
	if got := Normalize(groupedOrder, nil); !slices.Equal(got, groupedOrder) {
		t.Fatalf("without products = %v", got)
	}
}

func TestMoveGrouped(t *testing.T) {
	cases := []struct {
		name string
		req  MoveRequest
		want []string
	}{
		{"member up inside its product", mv("n2", "n1", PlaceBefore), []string{"s", "n2", "n1", "x", "w1", "w2", "w3"}},
		{"member to the end of its product", mv("w1", "w3", PlaceAfter), []string{"s", "n1", "n2", "x", "w2", "w3", "w1"}},
		{"product above a plain workspace", block("n1", "s", PlaceBefore), []string{"n1", "n2", "s", "x", "w1", "w2", "w3"}},
		{"product named by its second member", block("n2", "x", PlaceAfter), []string{"s", "x", "n1", "n2", "w1", "w2", "w3"}},
		{"product after another product", block("n1", "w3", PlaceAfter), []string{"s", "x", "w1", "w2", "w3", "n1", "n2"}},
		{"product before another product", block("w2", "n1", PlaceBefore), []string{"s", "w1", "w2", "w3", "n1", "n2", "x"}},
		{"plain workspace before a product", mv("x", "n1", PlaceBefore), []string{"s", "x", "n1", "n2", "w1", "w2", "w3"}},
		{"plain workspace after a product", mv("s", "w3", PlaceAfter), []string{"n1", "n2", "x", "w1", "w2", "w3", "s"}},
		{"plain next to plain", mv("s", "x", PlaceAfter), []string{"n1", "n2", "x", "s", "w1", "w2", "w3"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed, err := MoveGrouped(groupedOrder, groupedProducts, tc.req)
			if err != nil {
				t.Fatalf("MoveGrouped(%+v): %v", tc.req, err)
			}
			if !slices.Equal(got, tc.want) || !changed {
				t.Fatalf("MoveGrouped(%+v) = %v, %v; want %v", tc.req, got, changed, tc.want)
			}
		})
	}
	if !slices.Equal(groupedOrder, []string{"s", "n1", "n2", "x", "w1", "w2", "w3"}) {
		t.Fatalf("MoveGrouped changed its input: %v", groupedOrder)
	}
}

func TestMoveGroupedRefuses(t *testing.T) {
	for name, req := range map[string]MoveRequest{
		"member outside its product":       mv("n1", "x", PlaceAfter),
		"member into another product":      mv("n1", "w1", PlaceBefore),
		"plain workspace inside a product": mv("x", "w2", PlaceBefore),
		"plain after a product's first":    mv("s", "w1", PlaceAfter),
		"product inside another product":   block("n1", "w2", PlaceAfter),
		"product next to its own member":   block("n1", "n2", PlaceAfter),
		"block of a plain workspace":       block("s", "x", PlaceAfter),
		"unknown place":                    mv("n1", "n2", "middle"),
	} {
		if _, _, err := MoveGrouped(groupedOrder, groupedProducts, req); err == nil {
			t.Fatalf("%s: MoveGrouped(%+v) accepted", name, req)
		}
	}
}

func TestMoveGroupedUnchangedAndInterleaved(t *testing.T) {
	if _, changed, err := MoveGrouped(groupedOrder, groupedProducts, mv("n1", "n2", PlaceBefore)); err != nil || changed {
		t.Fatalf("a member already in place: changed=%v err=%v", changed, err)
	}
	// An order stored before the site joined the group: the move writes it normalized.
	stored := []string{"n1", "s", "n2"}
	got, changed, err := MoveGrouped(stored, map[string]string{"n1": "n", "n2": "n"}, mv("s", "n2", PlaceAfter))
	if err != nil || !changed || !slices.Equal(got, []string{"n1", "n2", "s"}) {
		t.Fatalf("interleaved: %v, %v, %v", got, changed, err)
	}
	// Without products the rule is #358's.
	got, _, err = MoveGrouped([]string{"a", "b", "c"}, nil, mv("c", "a", PlaceBefore))
	if err != nil || !slices.Equal(got, []string{"c", "a", "b"}) {
		t.Fatalf("no products: %v, %v", got, err)
	}
}
