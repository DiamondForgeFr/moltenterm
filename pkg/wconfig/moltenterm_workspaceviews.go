// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

// NewWorkspaceViewType is one view of the template a new workspace starts with (FR-SHELL-092, #1305). NameKey names
// it by a dictionary key, shown in the interface language until the developer renames the view; Name is a name the
// developer typed. Panels are panel kinds, as pkg/wcore/moltenterm_workspaceviews.go maps them.
type NewWorkspaceViewType struct {
	Name    string   `json:"name,omitempty"`
	NameKey string   `json:"namekey,omitempty"`
	Panels  []string `json:"panels"`
}
