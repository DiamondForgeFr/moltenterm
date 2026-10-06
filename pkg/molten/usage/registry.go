// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// Registry maps the companion's agent ids to their usage adapters. It is built once and only read afterwards.
type Registry struct {
	adapters map[string]UsageAdapter
}

// MakeRegistry checks every adapter and refuses the whole set on the first bad one: a usage page opens in the
// browser panel from a click, so it must be the provider's own https page (FR-SHELL-026 validation rule).
func MakeRegistry(adapters ...UsageAdapter) (*Registry, error) {
	r := &Registry{adapters: map[string]UsageAdapter{}}
	for _, a := range adapters {
		if a == nil {
			return nil, fmt.Errorf("nil usage adapter")
		}
		id := a.Id()
		if id == "" {
			return nil, fmt.Errorf("usage adapter without an agent id")
		}
		if _, dup := r.adapters[id]; dup {
			return nil, fmt.Errorf("two usage adapters for %s", id)
		}
		if err := ValidatePageURL(a.PageURL(), a.Domain()); err != nil {
			return nil, fmt.Errorf("usage adapter %s: %w", id, err)
		}
		if strings.TrimSpace(a.PageName()) == "" {
			return nil, fmt.Errorf("usage adapter %s: no page name", id)
		}
		r.adapters[id] = a
	}
	return r, nil
}

// ValidatePageURL accepts an https URL whose host is the provider's domain or one of its subdomains, without
// credentials or an explicit port.
func ValidatePageURL(pageURL string, domain string) error {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" || strings.Trim(domain, ".") != domain || !strings.Contains(domain, ".") {
		return fmt.Errorf("invalid provider domain %q", domain)
	}
	if pageURL == "" {
		return fmt.Errorf("no usage page URL")
	}
	u, err := url.Parse(pageURL)
	if err != nil {
		return fmt.Errorf("invalid usage page URL")
	}
	if u.Scheme != "https" {
		return fmt.Errorf("the usage page must be https")
	}
	if u.User != nil || u.Port() != "" || u.Opaque != "" {
		return fmt.Errorf("the usage page URL must not carry credentials or a port")
	}
	host := strings.ToLower(u.Hostname())
	if host != domain && !strings.HasSuffix(host, "."+domain) {
		return fmt.Errorf("the usage page must be on %s", domain)
	}
	return nil
}

// For returns the agent's adapter, or nil when the agent has none.
func (r *Registry) For(agent string) UsageAdapter {
	if r == nil {
		return nil
	}
	return r.adapters[agent]
}

// Agents lists the agents with a usage adapter, sorted.
func (r *Registry) Agents() []string {
	if r == nil {
		return nil
	}
	rtn := make([]string, 0, len(r.adapters))
	for id := range r.adapters {
		rtn = append(rtn, id)
	}
	sort.Strings(rtn)
	return rtn
}

var defaultRegistry = mustBuiltinRegistry()

func mustBuiltinRegistry() *Registry {
	r, err := MakeRegistry(MakeClaudeUsageAdapter(), MakeCodexUsageAdapter())
	if err != nil {
		// A built-in adapter with a bad page is a programming error: refuse it at startup, never at a click.
		panic(err)
	}
	return r
}

// For returns the built-in adapter of an agent, or nil when the agent has none.
func For(agent string) UsageAdapter {
	return defaultRegistry.For(agent)
}

// Agents lists the agents with a built-in usage adapter.
func Agents() []string {
	return defaultRegistry.Agents()
}
