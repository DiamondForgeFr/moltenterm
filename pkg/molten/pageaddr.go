// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"math"
	"net/url"
	"sort"
	"strings"
	"unicode"
)

// Finding a page that is already open (FR-BRW-008, #2333): an agent that asks for an address, and `molten open`, reuse
// the page a browser panel already shows instead of opening it again. wavesrv (the agent's tools) and wsh (`molten
// open`) share these rules, so both agree on what "the same page" is.

const (
	maskedValue         = "***"
	maxListedAddressLen = 500
)

// A query parameter whose value stays out of a listed address: its name holds one of these words (after dropping - and
// _), or is one of the names below exactly.
var sensitiveQueryWords = []string{
	"token", "secret", "password", "passwd", "passphrase", "credential", "signature", "session", "apikey", "accesskey",
	"privatekey", "authorization", "bearer", "jwt", "csrf", "xsrf",
}

var sensitiveQueryNames = map[string]bool{
	"key": true, "code": true, "sig": true, "sid": true, "auth": true, "otp": true, "pwd": true, "pass": true,
	"ticket": true, "state": true, "nonce": true, "hash": true,
}

// NormalizePageAddress is the key two addresses of the same page share: scheme and host in lower case, the default port
// and a trailing slash dropped, the fragment ignored, the query kept as written. An address that carries credentials, or
// is not an http(s) page, has no key: it never matches another.
func NormalizePageAddress(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	hostname := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if hostname == "" {
		return "", false
	}
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port != "" {
		host += ":" + port
	}
	key := scheme + "://" + host + strings.TrimRight(u.EscapedPath(), "/")
	if u.RawQuery != "" {
		key += "?" + u.RawQuery
	}
	return key, true
}

func sensitiveQueryName(name string) bool {
	lower := strings.ToLower(name)
	if sensitiveQueryNames[lower] {
		return true
	}
	squeezed := strings.NewReplacer("-", "", "_", "").Replace(lower)
	if sensitiveQueryNames[squeezed] {
		return true
	}
	for _, word := range sensitiveQueryWords {
		if strings.Contains(squeezed, word) {
			return true
		}
	}
	return false
}

func maskQuery(rawQuery string) string {
	parts := strings.Split(rawQuery, "&")
	for i, part := range parts {
		name, _, hasValue := strings.Cut(part, "=")
		if !hasValue {
			continue
		}
		if decoded, err := url.QueryUnescape(name); err == nil {
			name = decoded
		}
		if sensitiveQueryName(name) {
			parts[i] = part[:strings.Index(part, "=")+1] + maskedValue
		}
	}
	return strings.Join(parts, "&")
}

// MaskPageAddress is an address as an agent may be told it (#2333): without credentials and fragment (a fragment may
// carry a token), the values of its sensitive query parameters replaced, on one line and not too long. "" for anything
// that is not an http(s) page.
func MaskPageAddress(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Hostname() == "" {
		return ""
	}
	rtn := scheme + "://" + u.Host + u.EscapedPath()
	if u.RawQuery != "" {
		rtn += "?" + maskQuery(u.RawQuery)
	}
	rtn = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return -1
		}
		return r
	}, rtn)
	if runes := []rune(rtn); len(runes) > maxListedAddressLen {
		rtn = string(runes[:maxListedAddressLen-1]) + "…"
	}
	return rtn
}

// OpenPage is one page of a browser panel that may be the page an address names.
type OpenPage struct {
	PanelId string
	TabId   string
	Url     string
	// Own: a tab of the session that asks, which it may use at once.
	Own bool
	// InView: the page the panel shows, in the Wave tab the workspace shows.
	InView bool
	// Recent: the rank of the panel in its Wave tab's focus history, 0 for the latest, negative when never focused.
	Recent int
	// Seq: higher is newer; the last tie-break.
	Seq int64
}

func recentRank(rank int) int {
	if rank < 0 {
		return math.MaxInt
	}
	return rank
}

func betterOpenPage(a OpenPage, b OpenPage) bool {
	if a.Own != b.Own {
		return a.Own
	}
	if a.InView != b.InView {
		return a.InView
	}
	if ra, rb := recentRank(a.Recent), recentRank(b.Recent); ra != rb {
		return ra < rb
	}
	return a.Seq > b.Seq
}

// MatchingOpenPages are the pages that show the target address, best first: the session's own tab, then the one in
// view, then the most recently focused panel, then the newest.
func MatchingOpenPages(pages []OpenPage, target string) []OpenPage {
	want, ok := NormalizePageAddress(target)
	if !ok {
		return nil
	}
	var rtn []OpenPage
	for _, page := range pages {
		if key, ok := NormalizePageAddress(page.Url); ok && key == want {
			rtn = append(rtn, page)
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool { return betterOpenPage(rtn[i], rtn[j]) })
	return rtn
}

// BestOpenPage is the first of MatchingOpenPages.
func BestOpenPage(pages []OpenPage, target string) (OpenPage, bool) {
	matches := MatchingOpenPages(pages, target)
	if len(matches) == 0 {
		return OpenPage{}, false
	}
	return matches[0], true
}
