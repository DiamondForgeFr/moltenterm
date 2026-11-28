// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func milestonesAnswerJson(titles ...string) []byte {
	var nodes []string
	for i, title := range titles {
		nodes = append(nodes, `{"number":`+string(rune('1'+i))+`,"title":"`+title+`","url":"https://github.com/o/r/milestone/`+string(rune('1'+i))+`","dueOn":null,"open":{"totalCount":1},"closed":{"totalCount":0}}`)
	}
	return []byte(`{"data":{"repository":{"milestones":{"nodes":[` + strings.Join(nodes, ",") + `]}}}}`)
}

// The ticket of a security fix belongs in the release being prepared: the oldest open version, not a milestone like Later
// (FR-REV-036 AC9).
func TestReleaseBeingPrepared(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		titles []string
		want   string
	}{
		"the oldest version first":                   {[]string{"1.1.0", "1.0.0", "Later"}, "1.0.0"},
		"a pre-release comes before its own release": {[]string{"1.0.0", "1.0.0-rc.1"}, "1.0.0-rc.1"},
		"a version with a word after it":             {[]string{"Later", "1.2.0 launch"}, "1.2.0 launch"},
		"no version at all":                          {[]string{"Later", "Ideas"}, ""},
		"no milestone":                               {nil, ""},
	} {
		gh := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			return milestonesAnswerJson(test.titles...), nil
		}
		if got := ReleaseBeingPrepared(t.Context(), gh, t.TempDir()); got != test.want {
			t.Errorf("%s: %q, want %q", name, got, test.want)
		}
	}
	failing := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		return nil, errors.New("gh is offline")
	}
	if got := ReleaseBeingPrepared(t.Context(), failing, t.TempDir()); got != "" {
		t.Fatalf("an unreadable forge gave %q, want no milestone", got)
	}
}
