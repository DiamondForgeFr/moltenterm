// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"reflect"
	"slices"
	"testing"
)

// #322: the settings screen and the companion write lists such as agent:integrateoff as decoded JSON ([]any).
func TestConvertConfigList(t *testing.T) {
	ctype := getConfigKeyType("agent:integrateoff")
	if ctype == nil || ctype.Kind() != reflect.Slice {
		t.Fatalf("agent:integrateoff type %v", ctype)
	}
	got, ok := convertConfigList([]any{"claude", "codex"}, ctype)
	if !ok || !slices.Equal(got.([]string), []string{"claude", "codex"}) {
		t.Fatalf("converted %v %v", got, ok)
	}
	if got, ok := convertConfigList([]any{}, ctype); !ok || len(got.([]string)) != 0 {
		t.Fatalf("empty list %v %v", got, ok)
	}
	if _, ok := convertConfigList([]any{"claude", 3.0}, ctype); ok {
		t.Fatalf("a number in a list of strings is refused")
	}
	if _, ok := convertConfigList([]any{nil}, ctype); ok {
		t.Fatalf("a null item is refused")
	}
}
