// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"reflect"
	"testing"
)

// #663: Electron main writes browser:sitepermissions through SetConfigCommand, which hands the object over as decoded
// JSON (map[string]any of map[string]any).
func TestConvertConfigMap(t *testing.T) {
	ctype := getConfigKeyType("browser:sitepermissions")
	if ctype == nil || ctype.Kind() != reflect.Map {
		t.Fatalf("browser:sitepermissions type %v", ctype)
	}
	decoded := map[string]any{"meet.example.com": map[string]any{"camera": "allow", "microphone": "block"}}
	got, ok := convertConfigMap(decoded, ctype)
	if !ok {
		t.Fatalf("not converted")
	}
	perms := got.(map[string]map[string]string)
	if perms["meet.example.com"]["camera"] != "allow" || perms["meet.example.com"]["microphone"] != "block" {
		t.Fatalf("converted %v", perms)
	}
	if _, ok := convertConfigMap(map[string]any{"x.com": "allow"}, ctype); ok {
		t.Fatalf("a string where a map is expected is refused")
	}
	if _, ok := convertConfigMap(map[string]any{"x.com": map[string]any{"camera": 3}}, ctype); ok {
		t.Fatalf("a number where a decision is expected is refused")
	}
	sites := getConfigKeyType("browser:agentsites")
	if got, ok := convertConfigMap(map[string]any{"example.com": "allow"}, sites); !ok || got.(map[string]string)["example.com"] != "allow" {
		t.Fatalf("flat map %v %v", got, ok)
	}
}
