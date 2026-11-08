// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// FR-SHELL-023 AC18 (#2089): the former sleep policy becomes Automatic and what a terminal's request gets.
func TestPowerMigration(t *testing.T) {
	cases := []struct {
		name     string
		settings waveobj.MetaMapType
		want     waveobj.MetaMapType
	}{
		{"nothing to migrate", waveobj.MetaMapType{"term:fontsize": 12}, nil},
		{
			"until work ends is Automatic with requests let through",
			waveobj.MetaMapType{"power:sleeppolicy": "untilworkends"},
			waveobj.MetaMapType{"power:sleeppolicy": nil, "power:automatic": true, "power:terminalrequests": "always"},
		},
		{
			"let it sleep refuses the requests and leaves Automatic off",
			waveobj.MetaMapType{"power:sleeppolicy": "letsleep"},
			waveobj.MetaMapType{"power:sleeppolicy": nil, "power:terminalrequests": "never"},
		},
		{
			"allow lets the requests through",
			waveobj.MetaMapType{"power:sleeppolicy": "allow"},
			waveobj.MetaMapType{"power:sleeppolicy": nil, "power:terminalrequests": "always"},
		},
		{
			"an unknown value is dropped, both settings stay at their default",
			waveobj.MetaMapType{"power:sleeppolicy": "never"},
			waveobj.MetaMapType{"power:sleeppolicy": nil},
		},
		{
			"a value already written under a new key is kept",
			waveobj.MetaMapType{"power:sleeppolicy": "untilworkends", "power:terminalrequests": "never"},
			waveobj.MetaMapType{"power:sleeppolicy": nil, "power:automatic": true},
		},
	}
	for _, c := range cases {
		if got := PowerMigration(c.settings); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
