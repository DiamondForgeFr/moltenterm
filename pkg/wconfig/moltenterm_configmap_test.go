// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
	// #1978: the files the user let a terminal open in the browser panel are a flat map of path to allow.
	pages := getConfigKeyType("browser:localpages")
	if got, ok := convertConfigMap(map[string]any{"/tmp/report/index.html": "allow"}, pages); !ok || got.(map[string]string)["/tmp/report/index.html"] != "allow" {
		t.Fatalf("local pages %v %v", got, ok)
	}
	if _, ok := convertConfigMap(map[string]any{"/tmp/report/index.html": true}, pages); ok {
		t.Fatalf("a boolean where a decision is expected is refused")
	}
	sites := getConfigKeyType("browser:agentsites")
	if got, ok := convertConfigMap(map[string]any{"example.com": "allow"}, sites); !ok || got.(map[string]string)["example.com"] != "allow" {
		t.Fatalf("flat map %v %v", got, ok)
	}
	// #1979: the certificate picked per site is a flat map of fingerprints too.
	certs := getConfigKeyType("browser:clientcertificates")
	if got, ok := convertConfigMap(map[string]any{"example.com": "sha256/abc"}, certs); !ok || got.(map[string]string)["example.com"] != "sha256/abc" {
		t.Fatalf("certificate map %v %v", got, ok)
	}
}
