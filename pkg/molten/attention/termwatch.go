// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The agent commands of the command panel (FR-SHELL-048, DS-SHELL-087) follow what a terminal's user types (a possible
// unsent draft) and what its agent draws (its permission mode). Observers run on the input and output paths: they
// must not block and must not keep the data.

type TerminalDataObserver func(blockId string, data []byte)

type termObservers struct {
	lock   sync.Mutex
	input  []TerminalDataObserver
	output []TerminalDataObserver
}

var defaultTermObservers = &termObservers{}

func (o *termObservers) add(input bool, observer TerminalDataObserver) {
	o.lock.Lock()
	defer o.lock.Unlock()
	if input {
		o.input = append(o.input, observer)
	} else {
		o.output = append(o.output, observer)
	}
}

func (o *termObservers) list(input bool) []TerminalDataObserver {
	o.lock.Lock()
	defer o.lock.Unlock()
	if input {
		return append([]TerminalDataObserver(nil), o.input...)
	}
	return append([]TerminalDataObserver(nil), o.output...)
}

func (o *termObservers) notify(input bool, blockId string, data []byte) {
	defer func() {
		panichandler.PanicHandler("molten:termwatch", recover())
	}()
	for _, observer := range o.list(input) {
		observer(blockId, data)
	}
}

// OnTerminalInput registers an observer of every input sent to a terminal (the user's keys and MoltenTerm's own).
func OnTerminalInput(observer TerminalDataObserver) {
	defaultTermObservers.add(true, observer)
}

// OnTerminalOutput registers an observer of every chunk of terminal output wavesrv stores.
func OnTerminalOutput(observer TerminalDataObserver) {
	defaultTermObservers.add(false, observer)
}

// AgentStatesPrecise tells whether the agent running in a terminal reports its states through its hooks: without
// them, an agent asking a question looks idle (#217).
func AgentStatesPrecise(blockId string) bool {
	return defaultAgentStates.precise(blockId)
}

func (a *agentStates) precise(blockId string) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	p := a.panes[blockId]
	return rec != nil && p != nil && rec.agent != "" && p.hookedAgent == rec.agent
}
