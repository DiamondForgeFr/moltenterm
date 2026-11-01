// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// The provider behind Claude Code (FR-AGC-008). Claude Code's hooks and status line read the host of
// ANTHROPIC_BASE_URL (agenthook/provider.go) and report it with the run's state; this file names it. A run with a
// provider gets no Anthropic plan gauges, its models and effort levels are marked as Anthropic's, and its card, its
// companion and its signature name the provider. Adding a provider is adding a row.

// AgentProvider is a provider known by the hosts of its Anthropic-compatible endpoint.
type AgentProvider struct {
	Name string
	// Domains: the host or any of its subdomains.
	Domains []string
}

var AgentProviders = []AgentProvider{
	{Name: "GLM", Domains: []string{"z.ai", "bigmodel.cn"}},
	{Name: "MiniMax", Domains: []string{"minimax.io", "minimaxi.com", "minimax.chat"}},
	{Name: "DeepSeek", Domains: []string{"deepseek.com"}},
	{Name: "Kimi", Domains: []string{"moonshot.ai", "moonshot.cn", "kimi.com"}},
	{Name: "Qwen", Domains: []string{"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"}},
	{Name: "OpenRouter", Domains: []string{"openrouter.ai"}},
}

// The provider an agent talks to unless told otherwise: what its plan gauges, models and effort levels belong to.
var nativeProviders = map[string]string{AgentIdClaude: "Anthropic"}

// NativeProviderName names an agent's own provider, "" when MoltenTerm does not name it.
func NativeProviderName(agentId string) string {
	return nativeProviders[agentId]
}

// What a signature says of a provider it does not know: its host may be a private gateway's, kept off pull requests.
const unknownProviderSignature = "another provider"

// CleanProviderHost keeps a reported provider host only when it reads as one, lowercase; "" for anything else and for
// Anthropic's hosts.
func CleanProviderHost(host string) string {
	if strings.Contains(host, "/") || strings.Contains(host, "@") {
		return ""
	}
	return agenthook.BaseUrlProviderHost(host)
}

// KnownProviderName names a provider host's provider, "" when it is not one of AgentProviders.
func KnownProviderName(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return ""
	}
	for _, p := range AgentProviders {
		for _, d := range p.Domains {
			if host == d || strings.HasSuffix(host, "."+d) {
				return p.Name
			}
		}
	}
	return ""
}

// ProviderDisplayName is how MoltenTerm's windows name a provider host: its provider's name, else the host itself.
func ProviderDisplayName(host string) string {
	if name := KnownProviderName(host); name != "" {
		return name
	}
	return strings.ToLower(strings.TrimSpace(host))
}

// AgentToolSignature is the agent part of a signature (agentsign): "Claude Code via GLM" for a run behind a provider,
// "Claude Code via another provider" for a host MoltenTerm does not know, the agent's name alone otherwise.
func AgentToolSignature(agentName string, providerHost string) string {
	if strings.TrimSpace(providerHost) == "" || agentName == "" {
		return agentName
	}
	name := KnownProviderName(providerHost)
	if name == "" {
		name = unknownProviderSignature
	}
	return agentName + " via " + name
}
