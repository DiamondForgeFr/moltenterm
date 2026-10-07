// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"fmt"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// PlannedAgent is an agent MoltenTerm knows that has no adapter yet: molten agent list shows it, Continue with…
// never offers it.
type PlannedAgent struct {
	Id         string
	Name       string
	Executable string
	Reason     string
}

const plannedReason = "no adapter yet (FR-CONT-013, #333)"

// PlannedAgents follow in FR-CONT-013.
var PlannedAgents = []PlannedAgent{
	{Id: molten.AgentIdGemini, Name: "Gemini CLI", Executable: "gemini", Reason: plannedReason},
	{Id: molten.AgentIdKimi, Name: "Kimi Code", Executable: "kimi", Reason: plannedReason},
	{Id: molten.AgentIdOpenCode, Name: "OpenCode", Executable: "opencode", Reason: plannedReason},
}

var validSupports = []string{SupportDocumented, SupportUndocumented, SupportUnavailable}
var validChannels = []string{ChannelSystemAppend, ChannelDeveloper, ChannelInstructionsFile, ChannelAgentFile, ChannelFirstMessage}

// Registry maps agent ids to their adapters, in registration order. It is built once and only read afterwards.
type Registry struct {
	adapters []AgentAdapter
}

// KnownAgentId accepts the ids of molten.AgentKinds and kimi (FR-CONT-006 validation rule).
func KnownAgentId(id string) bool {
	return id == molten.AgentIdKimi || molten.FindAgentKind(id) != nil
}

// MakeRegistry checks every adapter and refuses the whole set on the first bad one: an adapter that declares an
// unknown support level or channel, or leaves a capability out, would let an interface offer what does not work.
func MakeRegistry(adapters ...AgentAdapter) (*Registry, error) {
	r := &Registry{}
	for _, a := range adapters {
		if err := checkAdapter(a); err != nil {
			return nil, err
		}
		if r.Find(a.Id()) != nil {
			return nil, fmt.Errorf("two agent adapters for %s", a.Id())
		}
		r.adapters = append(r.adapters, a)
	}
	return r, nil
}

func checkAdapter(a AgentAdapter) error {
	if a == nil {
		return fmt.Errorf("nil agent adapter")
	}
	id := a.Id()
	if !KnownAgentId(id) {
		return fmt.Errorf("agent adapter %q: not an agent id of molten.AgentKinds", id)
	}
	if strings.TrimSpace(a.Name()) == "" || strings.TrimSpace(a.Executable()) == "" {
		return fmt.Errorf("agent adapter %s: no name or executable", id)
	}
	briefing := a.Briefing()
	if !slices.Contains(validChannels, briefing.Channel) || !slices.Contains(validSupports, briefing.Support) {
		return fmt.Errorf("agent adapter %s: invalid briefing channel %q (%q)", id, briefing.Channel, briefing.Support)
	}
	caps := a.Capabilities()
	for _, name := range AllCapabilities {
		c, ok := caps[name]
		if !ok {
			return fmt.Errorf("agent adapter %s: capability %s not declared", id, name)
		}
		if !slices.Contains(validSupports, c.Support) {
			return fmt.Errorf("agent adapter %s: capability %s has support %q", id, name, c.Support)
		}
		if c.InUse && c.Support == SupportUnavailable {
			return fmt.Errorf("agent adapter %s: capability %s is unavailable but in use", id, name)
		}
	}
	if len(caps) != len(AllCapabilities) {
		return fmt.Errorf("agent adapter %s: unknown capabilities declared", id)
	}
	if caps[CapBriefing].Support != briefing.Support {
		return fmt.Errorf("agent adapter %s: briefing support differs from its channel's", id)
	}
	return nil
}

// Find returns the adapter of an agent id, or nil.
func (r *Registry) Find(id string) AgentAdapter {
	if r == nil {
		return nil
	}
	for _, a := range r.adapters {
		if a.Id() == id {
			return a
		}
	}
	return nil
}

// Lookup returns the adapter of an agent id, or an error naming the supported ids.
func (r *Registry) Lookup(id string) (AgentAdapter, error) {
	if a := r.Find(id); a != nil {
		return a, nil
	}
	for _, p := range PlannedAgents {
		if p.Id == id {
			return nil, fmt.Errorf("%s: %s", p.Name, p.Reason)
		}
	}
	return nil, fmt.Errorf("unknown agent %q; supported: %s", id, strings.Join(r.Ids(), ", "))
}

// Adapters lists the adapters in registration order.
func (r *Registry) Adapters() []AgentAdapter {
	if r == nil {
		return nil
	}
	return append([]AgentAdapter(nil), r.adapters...)
}

// Ids lists the agent ids with an adapter, in registration order.
func (r *Registry) Ids() []string {
	var rtn []string
	for _, a := range r.Adapters() {
		rtn = append(rtn, a.Id())
	}
	return rtn
}

var defaultRegistry = mustBuiltinRegistry()

func mustBuiltinRegistry() *Registry {
	r, err := MakeRegistry(claudeAdapter{}, codexAdapter{})
	if err != nil {
		// A built-in adapter with a bad declaration is a programming error: refuse it at startup.
		panic(err)
	}
	return r
}

// Default is the registry of the built-in adapters.
func Default() *Registry {
	return defaultRegistry
}

// Find returns the built-in adapter of an agent id, or nil.
func Find(id string) AgentAdapter {
	return defaultRegistry.Find(id)
}
