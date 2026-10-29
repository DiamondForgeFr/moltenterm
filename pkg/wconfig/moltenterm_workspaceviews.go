// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import "strings"

const (
	// must match frontend/moltenterm-shell/workspace-views/workspace-views-model.ts
	// A template view with neither a name nor a key; a key outside ViewNameKeyPrefix reads as this one.
	DefaultViewNameKey = "workspaceViews.names.view"
	ViewNameKeyPrefix  = "workspaceViews.names."
)

// The English of the view-name keys, as frontend/moltenterm-shell/i18n/locales/en.json words them (a test checks).
var viewNamesEnglish = map[string]string{
	"workspaceViews.names.scoping":     "Scoping",
	"workspaceViews.names.integration": "Integration",
	"workspaceViews.names.pilotage":    "Control room",
	DefaultViewNameKey:                 "View",
}

// NewWorkspaceViewType is one view of the template a new workspace starts with (FR-SHELL-092, #1305). NameKey names
// it by a dictionary key, shown in the interface language until the developer renames the view; Name is a name the
// developer typed. Panels are panel kinds, as pkg/wcore/moltenterm_workspaceviews.go maps them.
type NewWorkspaceViewType struct {
	Name    string   `json:"name,omitempty"`
	NameKey string   `json:"namekey,omitempty"`
	Panels  []string `json:"panels"`
}

// ViewNameText is a tab's name in English, for text wavesrv writes itself (agents, `molten` and `wsh` output, logs): a
// default view never renamed is still named by its key (#1311). A window words the key in the interface language
// instead, so a name a window shows travels as stored.
func ViewNameText(name string) string {
	if !strings.HasPrefix(name, ViewNameKeyPrefix) {
		return name
	}
	if english, ok := viewNamesEnglish[name]; ok {
		return english
	}
	return viewNamesEnglish[DefaultViewNameKey]
}
