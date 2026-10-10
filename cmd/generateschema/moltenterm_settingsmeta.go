// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"github.com/invopop/jsonschema"
	"github.com/wavetermdev/waveterm/pkg/molten/settingsmeta"
)

// MoltentermSettingsMetaKeyword carries the settings screen's metadata (FR-SHELL-050) on each property of
// schema/settings.json; JSON Schema ignores keywords it does not know, so the config editor's validation is unchanged.
const MoltentermSettingsMetaKeyword = "x-moltenterm"

// A key without metadata keeps its plain schema and shows under Advanced in the settings screen.
func moltentermAnnotateSettings(schema *jsonschema.Schema) {
	for _, def := range schema.Definitions {
		if def.Properties == nil {
			continue
		}
		for pair := def.Properties.Oldest(); pair != nil; pair = pair.Next() {
			meta, ok := settingsmeta.Lookup(pair.Key)
			if !ok {
				continue
			}
			prop := pair.Value
			if prop.Description == "" && meta.Description != "" {
				prop.Description = meta.Description
			}
			if prop.Extras == nil {
				prop.Extras = map[string]any{}
			}
			prop.Extras[MoltentermSettingsMetaKeyword] = meta
		}
	}
}
