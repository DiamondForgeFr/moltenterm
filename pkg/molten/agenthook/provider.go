// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"net/url"
	"strings"
)

// The provider behind Claude Code (FR-AGC-008): Claude Code talks to another provider (GLM, MiniMax, DeepSeek...)
// through ANTHROPIC_BASE_URL, exported in the shell or set in its settings' env, which its hooks and status line
// inherit. Only the host of that URL is read: never the token (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY), never the
// URL's path or credentials.

const (
	ClaudeBaseUrlVar = "ANTHROPIC_BASE_URL"
	claudeAgentId    = "claude"
	// A host longer than this is not a host.
	providerHostMax = 253
)

// ProviderHost is the host Claude Code's requests go to when it is not Anthropic's, "" for Anthropic or when
// ANTHROPIC_BASE_URL is unset or unreadable.
func ProviderHost(getenv func(string) string) string {
	return BaseUrlProviderHost(getenv(ClaudeBaseUrlVar))
}

// BaseUrlProviderHost reads a base URL's host, lowercase and without its port; "" for an Anthropic host.
func BaseUrlProviderHost(baseUrl string) string {
	baseUrl = strings.TrimSpace(baseUrl)
	if baseUrl == "" {
		return ""
	}
	if !strings.Contains(baseUrl, "://") {
		baseUrl = "https://" + baseUrl
	}
	u, err := url.Parse(baseUrl)
	if err != nil {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || len(host) > providerHostMax || !validHost(host) || IsAnthropicHost(host) {
		return ""
	}
	return host
}

// IsAnthropicHost: anthropic.com and its subdomains (api.anthropic.com, the default).
func IsAnthropicHost(host string) bool {
	return host == "anthropic.com" || strings.HasSuffix(host, ".anthropic.com")
}

func validHost(host string) bool {
	for i := 0; i < len(host); i++ {
		c := host[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '.' && c != ':' {
			return false
		}
	}
	return true
}

// ProviderHostFor: the provider host of a report about agent, Claude Code's only (another agent's env may export
// ANTHROPIC_BASE_URL for something else).
func ProviderHostFor(agent string, getenv func(string) string) string {
	if agent != claudeAgentId || getenv == nil {
		return ""
	}
	return ProviderHost(getenv)
}
