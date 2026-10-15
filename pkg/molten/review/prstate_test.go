// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func prStateGh(answer string, calls *[][]string) GhRunner {
	return func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		*calls = append(*calls, args)
		if answer == "" {
			return nil, fmt.Errorf("gh: not found")
		}
		return []byte(answer), nil
	}
}

func TestPrState(t *testing.T) {
	oid := strings.Repeat("d", 40)
	cases := []struct {
		name   string
		answer string
		want   PrStateResult
		err    string
	}{
		{
			name:   "merged",
			answer: `{"number":7,"state":"MERGED","mergedAt":"2026-10-15T10:00:00Z","closedAt":"2026-10-15T10:00:00Z","baseRefName":"develop","mergeCommit":{"oid":"` + oid + `"}}`,
			want:   PrStateResult{State: PrStateMerged, BaseRef: "develop", MergedOid: oid, MergedAt: "2026-10-15T10:00:00Z"},
		},
		{
			name:   "closed",
			answer: `{"number":7,"state":"CLOSED","closedAt":"2026-10-15T11:00:00Z","baseRefName":"develop","mergeCommit":null}`,
			want:   PrStateResult{State: PrStateClosed, BaseRef: "develop", ClosedAt: "2026-10-15T11:00:00Z"},
		},
		{
			name:   "open",
			answer: `{"number":7,"state":"OPEN","baseRefName":"develop"}`,
			want:   PrStateResult{State: PrStateOpen, BaseRef: "develop"},
		},
		{name: "another pr", answer: `{"number":8,"state":"OPEN"}`, err: "did not answer"},
		{name: "unknown state", answer: `{"number":7,"state":"WEIRD"}`, err: "unknown state"},
		{name: "unreadable", answer: `not json`, err: "unreadable"},
		{name: "gh fails", answer: "", err: "gh: not found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var calls [][]string
			m := MakeMerger(MakeStore(t.TempDir()), prStateGh(c.answer, &calls), nil)
			got, err := m.PrState(context.Background(), PrStateRequest{Dir: "/x", Repo: testRepo, Number: 7})
			if c.err != "" {
				if err == nil || !strings.Contains(err.Error(), c.err) {
					t.Fatalf("error = %v, want %q", err, c.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("PrState: %v", err)
			}
			if got != c.want {
				t.Fatalf("PrState = %+v, want %+v", got, c.want)
			}
			if len(calls) != 1 {
				t.Fatalf("gh calls = %v, want one", calls)
			}
			args := strings.Join(calls[0], " ")
			if !strings.HasPrefix(args, "pr view 7 --json ") || !strings.HasSuffix(args, "--repo "+testRepo) {
				t.Fatalf("gh args = %q", args)
			}
		})
	}
}

func TestPrStateNeedsThePr(t *testing.T) {
	var calls [][]string
	m := MakeMerger(MakeStore(t.TempDir()), prStateGh(`{}`, &calls), nil)
	if _, err := m.PrState(context.Background(), PrStateRequest{Repo: testRepo}); err == nil {
		t.Fatalf("PrState without a number succeeded")
	}
	if len(calls) != 0 {
		t.Fatalf("gh was called: %v", calls)
	}
}
