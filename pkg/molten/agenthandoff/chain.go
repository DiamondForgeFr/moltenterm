// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"errors"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten/agentchain"
)

// The responsibility chain (FR-REV-035, #2174): a hand-off from one agent to another by first name is a delegation,
// and the lead to sub-agent link it makes is kept (pkg/molten/agentchain) for the Integration panel, which follows a
// view's agents and the sub-agents they delegated to. Only a hand-off both of whose ends have a first name makes a
// link: MoltenTerm's own requests (the developer's click) and unnamed terminals do not.

// OpenChain opens the chain kept in MoltenTerm's data folder.
func OpenChain(dataDir string) *agentchain.Registry {
	if dataDir == "" {
		return agentchain.Open("")
	}
	return agentchain.Open(filepath.Join(dataDir, "molten", agentchain.FileName))
}

func (m *Manager) recordChain(from Party, to Party) {
	if m.chain == nil || from.App || from.FirstName == "" || to.FirstName == "" {
		return
	}
	changed, err := m.chain.Record(from.FirstName, to.FirstName, from.BlockId, to.BlockId, agentchain.ViaHandoff)
	if err != nil {
		m.logf("%s no link kept: %v\n", logPrefix, err)
		return
	}
	if changed && m.chainChanged != nil {
		m.chainChanged()
	}
}

// Chain gives a window the links kept, the oldest first.
func (m *Manager) Chain(source string) (ChainResult, error) {
	if !isUiSource(source) {
		return ChainResult{}, errors.New(errNotUi)
	}
	rtn := ChainResult{Edges: []ChainEdge{}}
	if m.chain == nil {
		return rtn, nil
	}
	for _, e := range m.chain.Edges() {
		rtn.Edges = append(rtn.Edges, ChainEdge{Lead: e.Lead, Sub: e.Sub, Via: e.Via, At: e.At})
	}
	return rtn, nil
}
