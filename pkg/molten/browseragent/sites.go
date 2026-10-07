// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"net"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// Site permissions (FR-BRW-009, DS-BRW-013/015): what a site is, how a decision applies to a URL, and which addresses
// navigate accepts.

const (
	SiteAllow = "allow"
	SiteBlock = "block"

	urlBack    = "back"
	urlForward = "forward"
)

var schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)

// cleanHost keeps the characters a host (and a port) may hold, so a site can label a log line or an envelope.
func cleanHost(host string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == ':' || r == '[' || r == ']' {
			return r
		}
		return -1
	}, strings.ToLower(host))
}

func webUrl(rawUrl string) (*url.URL, bool) {
	u, err := url.Parse(rawUrl)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, false
	}
	// A host with characters no browser resolves is refused, not cleaned: cleaning could name another site.
	if cleanHost(u.Host) != strings.ToLower(u.Host) {
		return nil, false
	}
	return u, true
}

// ownSiteHost: localhost, IP addresses and single-label hosts have no registrable domain; they are sites of their own,
// port included, so a dev server on :3000 is not the one on :8080.
func ownSiteHost(hostname string) bool {
	return hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") || net.ParseIP(hostname) != nil ||
		!strings.Contains(hostname, ".")
}

// permissionSite is the site a decision is recorded for: the registrable domain of the page's host (mail.example.co.uk
// is example.co.uk), or host:port for localhost and IP addresses. "" for anything that is not an http(s) page.
func permissionSite(rawUrl string) string {
	u, ok := webUrl(rawUrl)
	if !ok {
		return ""
	}
	hostname := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if ownSiteHost(hostname) {
		return cleanHost(strings.TrimSuffix(strings.ToLower(u.Host), "."))
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(hostname)
	if err != nil {
		// The host is a public suffix itself (github.io): it is its own site.
		site = hostname
	}
	return cleanHost(site)
}

// siteCandidates are the settings keys that apply to a page, most specific first: host:port, the host, then each
// parent domain down to the registrable one.
func siteCandidates(rawUrl string) []string {
	u, ok := webUrl(rawUrl)
	if !ok {
		return nil
	}
	site := permissionSite(rawUrl)
	hostname := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	var rtn []string
	if u.Port() != "" {
		rtn = append(rtn, cleanHost(strings.ToLower(u.Host)))
	}
	if ownSiteHost(hostname) {
		return append(rtn, cleanHost(hostname))
	}
	for host := hostname; host != ""; {
		rtn = append(rtn, cleanHost(host))
		if host == site {
			break
		}
		dot := strings.Index(host, ".")
		if dot < 0 {
			break
		}
		host = host[dot+1:]
	}
	return rtn
}

// storedDecision is the user's stored decision for a page: Block wins over Allow wherever it is set.
func storedDecision(sites map[string]string, rawUrl string) string {
	if len(sites) == 0 {
		return ""
	}
	normalized := make(map[string]string, len(sites))
	for k, v := range sites {
		normalized[strings.ToLower(strings.TrimSpace(k))] = strings.ToLower(strings.TrimSpace(v))
	}
	decision := ""
	for _, candidate := range siteCandidates(rawUrl) {
		switch normalized[candidate] {
		case SiteBlock:
			return SiteBlock
		case SiteAllow:
			decision = SiteAllow
		}
	}
	return decision
}

// validSiteKey accepts what permissionSite produces (and what a user would type): a host, optionally with a port.
func validSiteKey(site string) bool {
	return site != "" && len(site) <= 253 && cleanHost(site) == site && !strings.HasPrefix(site, ".") &&
		!strings.HasSuffix(site, ".")
}

// navigateTarget turns navigate's url into the address to load (DS-BRW-015): a bare host gets https, localhost and
// 127.0.0.1 get http (as `molten open` and the address bar do); anything but http(s) is refused.
func navigateTarget(arg string) (string, string) {
	text := strings.TrimSpace(arg)
	if text == "" {
		return "", "missing"
	}
	if !schemeRe.MatchString(text) || isHostPort(text) {
		lower := strings.ToLower(text)
		if strings.HasPrefix(lower, "localhost") || strings.HasPrefix(lower, "127.0.0.1") || strings.HasPrefix(lower, "[::1]") {
			text = "http://" + text
		} else {
			text = "https://" + text
		}
	}
	u, ok := webUrl(text)
	if !ok || u.User != nil {
		return "", "scheme"
	}
	return u.String(), ""
}

// isHostPort tells "localhost:3000/x" (a host with a port) from a scheme such as "mailto:".
var hostPortRe = regexp.MustCompile(`^[a-zA-Z0-9.-]+:[0-9]+(/|$|\?|#)`)

func isHostPort(text string) bool {
	return hostPortRe.MatchString(text)
}

// originOf is a page's scheme and host, what is said of a page the agent may not read yet.
func originOf(rawUrl string) string {
	u, ok := webUrl(rawUrl)
	if !ok {
		return ""
	}
	return u.Scheme + "://" + cleanHost(u.Host)
}
