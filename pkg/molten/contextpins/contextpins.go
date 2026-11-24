// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package contextpins keeps the views pinned in the top row of the sidebar per context (FR-SHELL-080, #2526). Until
// then the client held one row, "molten:globalpins", that every workspace of every context showed. Each context now
// holds its own row in the client meta, under one key per context: two windows that pin in different contexts never
// overwrite each other. The first start after the update copies the former row into every existing context, once.
// This file holds the pure rules; pkg/wcore/moltenterm_contextpins.go reads and writes them, and
// frontend/moltenterm-shell/sidebar/context-pins-model.ts is their window-side twin.
package contextpins

import (
	"encoding/json"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	// MetaKeyPrefix followed by a context's id is the client meta key that holds that context's row. must match
	// frontend/moltenterm-shell/sidebar/context-pins-model.ts
	MetaKeyPrefix = "molten:contextpins:"
	// MigratedMetaKey marks the client whose former row was copied into its contexts: nothing is copied twice.
	MigratedMetaKey = "molten:contextpinsmigrated"
	// LegacyMetaKey is the row an earlier version kept for the whole client (viewpin.GlobalPinsMetaKey).
	LegacyMetaKey = "molten:globalpins"
)

// MetaKey is the client meta key of a context's row.
func MetaKey(contextId string) string {
	return MetaKeyPrefix + contextId
}

// Has tells whether the client meta holds a row of its own for a context, empty or not.
func Has(meta waveobj.MetaMapType, contextId string) bool {
	_, ok := meta[MetaKey(contextId)].([]any)
	return ok
}

// PinsOf is a context's row as the client meta stores it; nil when the context has none.
func PinsOf(meta waveobj.MetaMapType, contextId string) []any {
	pins, _ := meta[MetaKey(contextId)].([]any)
	return pins
}

func clonePins(pins []any) []any {
	if len(pins) == 0 {
		return []any{}
	}
	data, err := json.Marshal(pins)
	if err != nil {
		return []any{}
	}
	var rtn []any
	if err := json.Unmarshal(data, &rtn); err != nil || rtn == nil {
		return []any{}
	}
	return rtn
}

// Orphans are the keys of the rows of contexts that are no longer in contextIds: a deleted context takes its row with
// it.
func Orphans(meta waveobj.MetaMapType, contextIds []string) []string {
	known := make(map[string]bool, len(contextIds))
	for _, id := range contextIds {
		known[MetaKey(id)] = true
	}
	var rtn []string
	for key := range meta {
		if strings.HasPrefix(key, MetaKeyPrefix) && !known[key] {
			rtn = append(rtn, key)
		}
	}
	return rtn
}

// Migrated tells whether the former row was already copied into the contexts.
func Migrated(meta waveobj.MetaMapType) bool {
	done, _ := meta[MigratedMetaKey].(bool)
	return done
}

// Migration is the patch of the client meta that copies the former row into each of the contexts, drops it, and marks
// the client; nil when it was done before. A context that already holds a row keeps it. Each context gets a copy of
// its own, so the rows diverge from there.
func Migration(meta waveobj.MetaMapType, contextIds []string) waveobj.MetaMapType {
	if Migrated(meta) {
		return nil
	}
	legacy, _ := meta[LegacyMetaKey].([]any)
	patch := waveobj.MetaMapType{MigratedMetaKey: true, LegacyMetaKey: nil}
	for _, id := range contextIds {
		if id == "" || Has(meta, id) {
			continue
		}
		patch[MetaKey(id)] = clonePins(legacy)
	}
	return patch
}
