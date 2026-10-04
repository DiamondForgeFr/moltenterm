// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// must match the reader in frontend/moltenterm-shell/releases/versions.test.ts
type vectorFile struct {
	Order    []string `json:"order"`
	Invalid  []string `json:"invalid"`
	Channels []struct {
		Rules   Rules  `json:"rules"`
		Tag     string `json:"tag"`
		Channel string `json:"channel"`
	} `json:"channels"`
	NextRc []struct {
		Rules Rules    `json:"rules"`
		Base  string   `json:"base"`
		Tags  []string `json:"tags"`
		Rc    int      `json:"rc"`
	} `json:"nextrc"`
	LastPublic []struct {
		Rules      Rules    `json:"rules"`
		Tags       []string `json:"tags"`
		LastPublic string   `json:"lastpublic"`
		LastRc     string   `json:"lastrc"`
	} `json:"lastpublic"`
	Bumps []struct {
		Last    string        `json:"last"`
		Commits []CommitInput `json:"commits"`
		Expect  *struct {
			Level   string `json:"level"`
			Version string `json:"version"`
			Reason  string `json:"reason"`
		} `json:"expect"`
	} `json:"bumps"`
	Plans []struct {
		Name     string        `json:"name"`
		Rules    Rules         `json:"rules"`
		Tags     []string      `json:"tags"`
		Commits  []CommitInput `json:"commits"`
		Channel  string        `json:"channel"`
		Override string        `json:"override"`
		Expect   PlanResult    `json:"expect"`
	} `json:"plans"`
}

func readVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestVectorsOrder(t *testing.T) {
	v := readVectors(t)
	for i, s := range v.Order {
		a, err := ParseVersion(s)
		if err != nil {
			t.Fatalf("%s: %v", s, err)
		}
		if a.String() != s {
			t.Errorf("%s prints as %s", s, a)
		}
		for j, other := range v.Order {
			b, _ := ParseVersion(other)
			want := compareInt(i, j)
			if got := Compare(a, b); got != want {
				t.Errorf("Compare(%s, %s) = %d, want %d", s, other, got, want)
			}
		}
	}
	for _, s := range v.Invalid {
		if _, err := ParseVersion(s); err == nil {
			t.Errorf("%q should not parse", s)
		}
	}
}

func TestVectorsTags(t *testing.T) {
	v := readVectors(t)
	for _, c := range v.Channels {
		if got := c.Rules.ChannelOfTag(c.Tag); got != c.Channel {
			t.Errorf("%+v ChannelOfTag(%q) = %q, want %q", c.Rules, c.Tag, got, c.Channel)
		}
	}
	for _, c := range v.NextRc {
		base, _ := ParseBase(c.Base)
		if got := c.Rules.NextRc(base, c.Tags); got != c.Rc {
			t.Errorf("NextRc(%s, %v) = %d, want %d", c.Base, c.Tags, got, c.Rc)
		}
	}
	for _, c := range v.LastPublic {
		if got := c.Rules.LastPublic(c.Tags); got != c.LastPublic {
			t.Errorf("LastPublic(%v) = %q, want %q", c.Tags, got, c.LastPublic)
		}
		if got := c.Rules.LastRc(c.Tags); got != c.LastRc {
			t.Errorf("LastRc(%v) = %q, want %q", c.Tags, got, c.LastRc)
		}
	}
}

func TestVectorsBumps(t *testing.T) {
	v := readVectors(t)
	for i, c := range v.Bumps {
		last, _ := ParseBase(c.Last)
		got := DecideBump(last, c.Commits)
		if c.Expect == nil {
			if got != nil {
				t.Errorf("bump %d: got %+v, want none", i, got)
			}
			continue
		}
		if got == nil || got.Level != c.Expect.Level || got.Version != c.Expect.Version || got.Reason != c.Expect.Reason {
			t.Errorf("bump %d: got %+v, want %+v", i, got, c.Expect)
		}
	}
}

func TestVectorsPlans(t *testing.T) {
	v := readVectors(t)
	for _, c := range v.Plans {
		got := c.Rules.Plan(c.Tags, c.Commits, c.Channel, c.Override)
		if !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("%s:\n got  %+v\n want %+v", c.Name, got, c.Expect)
		}
	}
}

func TestBumpCountsUnconventional(t *testing.T) {
	got := DecideBump(Version{Major: 1}, []CommitInput{{Subject: "Update"}, {Subject: "fix: a"}})
	if got.Counts[UnconventionalCount] != 1 || got.Counts["fix"] != 1 {
		t.Errorf("counts = %v", got.Counts)
	}
}
