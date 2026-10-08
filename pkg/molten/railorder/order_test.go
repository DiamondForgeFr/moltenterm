// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestApplyOrder(t *testing.T) {
	cases := []struct {
		name   string
		listed []string
		stored []string
		want   []string
	}{
		{"no stored order keeps Wave's", []string{"a", "b", "c"}, nil, []string{"a", "b", "c"}},
		{"stored order first", []string{"a", "b", "c"}, []string{"c", "a", "b"}, []string{"c", "a", "b"}},
		{"a new workspace comes last", []string{"a", "b", "c", "e"}, []string{"c", "a", "b"}, []string{"c", "a", "b", "e"}},
		{"a deleted workspace leaves no gap", []string{"a", "c"}, []string{"c", "b", "a"}, []string{"c", "a"}},
		{"unstored ones follow in Wave's order", []string{"x", "a", "y", "b"}, []string{"b", "a"}, []string{"b", "a", "x", "y"}},
		{"duplicates in the stored order count once", []string{"a", "b"}, []string{"b", "b", "a"}, []string{"b", "a"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ApplyOrder(tc.listed, tc.stored)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("ApplyOrder(%v, %v) = %v, want %v", tc.listed, tc.stored, got, tc.want)
			}
		})
	}
}

func TestMove(t *testing.T) {
	order := []string{"a", "b", "c", "d"}
	cases := []struct {
		name    string
		req     MoveRequest
		want    []string
		changed bool
	}{
		{"before a neighbour above", mv("d", "b", PlaceBefore), []string{"a", "d", "b", "c"}, true},
		{"after a neighbour below", mv("a", "b", PlaceAfter), []string{"b", "a", "c", "d"}, true},
		{"to the top", mv("c", "a", PlaceBefore), []string{"c", "a", "b", "d"}, true},
		{"to the bottom", mv("a", "d", PlaceAfter), []string{"b", "c", "d", "a"}, true},
		{"already there", mv("b", "c", PlaceBefore), []string{"a", "b", "c", "d"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed, err := Move(order, tc.req)
			if err != nil {
				t.Fatalf("Move: %v", err)
			}
			if !slices.Equal(got, tc.want) || changed != tc.changed {
				t.Fatalf("Move(%+v) = %v, %v; want %v, %v", tc.req, got, changed, tc.want, tc.changed)
			}
		})
	}
	if !slices.Equal(order, []string{"a", "b", "c", "d"}) {
		t.Fatalf("Move changed its input: %v", order)
	}
}

func TestMoveRefuses(t *testing.T) {
	order := []string{"a", "b"}
	for _, req := range []MoveRequest{
		mv("a", "b", "middle"),
		mv("a", "a", PlaceBefore),
		mv("", "b", PlaceBefore),
		mv("unsaved", "b", PlaceBefore),
		mv("a", "gone", PlaceAfter),
	} {
		if _, _, err := Move(order, req); err == nil {
			t.Fatalf("Move(%+v) accepted", req)
		}
	}
}

func TestReadOrder(t *testing.T) {
	if got := ReadOrder(waveobj.MetaMapType{}); got != nil {
		t.Fatalf("no meta: %v", got)
	}
	if got := ReadOrder(waveobj.MetaMapType{MetaKey: "a"}); got != nil {
		t.Fatalf("a string is not an order: %v", got)
	}
	fromDb := waveobj.MetaMapType{MetaKey: []any{"a", 3, "", "b"}}
	if got := ReadOrder(fromDb); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("from the database: %v", got)
	}
	inMemory := waveobj.MetaMapType{MetaKey: []string{"b", "a"}}
	if got := ReadOrder(inMemory); !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("in memory: %v", got)
	}
	if got := ReadOrder(waveobj.MetaMapType{MetaKey: MetaValue([]string{"c"})}); !slices.Equal(got, []string{"c"}) {
		t.Fatalf("round trip: %v", got)
	}
}

func TestGrouping(t *testing.T) {
	defer SetGrouping(nil, nil, nil)
	ctx := context.Background()
	if products, err := ProductsOf(ctx); err != nil || products.Of != nil {
		t.Fatalf("no grouping set: %v, %v", products, err)
	}
	Moved()
	TellDisplaced([]Displaced{{WorkspaceId: "a"}})
	told := 0
	var displaced []Displaced
	SetGrouping(func(ctx context.Context) (ProductMap, error) {
		return ProductMap{Of: map[string]string{"a": "p"}}, nil
	}, func() { told++ }, func(d []Displaced) { displaced = d })
	if products, err := ProductsOf(ctx); err != nil || products.Of["a"] != "p" {
		t.Fatalf("grouping not applied: %v, %v", products, err)
	}
	Moved()
	if told != 1 {
		t.Fatalf("moved told %d times", told)
	}
	TellDisplaced(nil)
	if displaced != nil {
		t.Fatalf("nothing displaced is not told")
	}
	TellDisplaced([]Displaced{{WorkspaceId: "a"}})
	if len(displaced) != 1 {
		t.Fatalf("displaced not told: %v", displaced)
	}
	failed := errors.New("unreadable")
	SetGrouping(func(ctx context.Context) (ProductMap, error) { return ProductMap{}, failed }, nil, nil)
	if _, err := ProductsOf(ctx); !errors.Is(err, failed) {
		t.Fatalf("error not passed on: %v", err)
	}
}

func mv(workspaceId string, targetId string, place string) MoveRequest {
	return MoveRequest{WorkspaceId: workspaceId, TargetId: targetId, Place: place}
}

func TestIsWindowSource(t *testing.T) {
	if !isWindowSource("tab:1234") {
		t.Fatalf("a tab is a window")
	}
	if isWindowSource("conn:local") || isWindowSource("") {
		t.Fatalf("a terminal is not a window")
	}
}
