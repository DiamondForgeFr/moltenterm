// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"

	"github.com/invopop/jsonschema"
)

// Moltenterm ships no built-in AI (FR-MORPH-008). The settings schema drives completion in the config editor, so it
// must not offer Wave's AI settings; the settings types keep them, which keeps upstream merges simple.
func moltentermDropAISettings(schema *jsonschema.Schema) {
	for _, def := range schema.Definitions {
		if def.Properties == nil {
			continue
		}
		var aiKeys []string
		for pair := def.Properties.Oldest(); pair != nil; pair = pair.Next() {
			if moltentermIsAISettingKey(pair.Key) {
				aiKeys = append(aiKeys, pair.Key)
			}
		}
		for _, key := range aiKeys {
			def.Properties.Delete(key)
		}
	}
}

func moltentermIsAISettingKey(key string) bool {
	return strings.HasPrefix(key, "ai:") || strings.HasPrefix(key, "waveai:") || key == "app:hideaibutton"
}
