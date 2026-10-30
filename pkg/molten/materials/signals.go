// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

// The generic part of the signals (DS-MAT-002): which addresses are productions (signal 2), and which absolute paths
// an answer names (signal 3). The adapters only say which records carry text; any agent gets these.

// HostRule is a host known to host productions: an address is one when its host is Host and its path starts with one
// of Prefixes.
type HostRule struct {
	Host     string
	Prefixes []string
}

var hostsLock sync.Mutex

var knownHosts = []HostRule{
	{Host: "claude.ai", Prefixes: []string{"/artifact/", "/code/artifact/", "/public/artifacts/"}},
}

// AddHosts extends the known hosts (an adapter for an agent whose tool publishes elsewhere).
func AddHosts(rules ...HostRule) {
	hostsLock.Lock()
	defer hostsLock.Unlock()
	knownHosts = append(knownHosts, rules...)
}

// IsProductionAddress tells whether an address is one of a known host's productions.
func IsProductionAddress(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	hostsLock.Lock()
	defer hostsLock.Unlock()
	for _, rule := range knownHosts {
		if host != rule.Host && host != "www."+rule.Host {
			continue
		}
		for _, prefix := range rule.Prefixes {
			if strings.HasPrefix(u.Path, prefix) && len(u.Path) > len(prefix) {
				return true
			}
		}
	}
	return false
}

var (
	webAddressRegex = regexp.MustCompile(`https://[^\s<>"'` + "`" + `)\]}]+`)
	// An absolute path: after a space, a quote, a parenthesis or a backtick; ~/ counts. Paths with spaces only inside
	// backticks or quotes.
	quotedPathRegex = regexp.MustCompile("[`\"']((?:~|/|[A-Za-z]:\\\\)[^`\"'\\n]{1,1000})[`\"']")
	barePathRegex   = regexp.MustCompile(`(?:^|[\s(\[<:=])((?:~/|/|[A-Za-z]:\\)[^\s"'<>` + "`" + `()\[\]{}|*?]{1,1000})`)
	fileUrlRegex    = regexp.MustCompile(`file://(/[^\s"'<>` + "`" + `()\[\]]+)`)
)

// ProductionAddresses picks the production addresses out of a text or a list of addresses.
func ProductionAddresses(texts ...string) []string {
	var rtn []string
	seen := map[string]bool{}
	for _, text := range texts {
		if !strings.Contains(text, "https://") {
			continue
		}
		for _, a := range webAddressRegex.FindAllString(text, 50) {
			a = strings.TrimRight(a, ".,;:!?*_")
			if seen[a] || !IsProductionAddress(a) {
				continue
			}
			seen[a] = true
			rtn = append(rtn, a)
		}
	}
	return rtn
}

// NamedPaths picks the absolute paths a text names, in order, each once; home is ~.
func NamedPaths(text string, home string) []string {
	var rtn []string
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimRight(strings.TrimSpace(p), ".,;:!?")
		if strings.HasPrefix(p, "~/") {
			if home == "" {
				return
			}
			p = filepath.Join(home, p[2:])
		}
		if decoded, err := url.PathUnescape(p); err == nil && strings.Contains(p, "%") {
			p = decoded
		}
		if !filepath.IsAbs(p) || (runtime.GOOS != "windows" && !strings.HasPrefix(p, "/")) {
			return
		}
		p = filepath.Clean(p)
		if seen[p] || len(rtn) >= 100 {
			return
		}
		seen[p] = true
		rtn = append(rtn, p)
	}
	for _, m := range fileUrlRegex.FindAllStringSubmatch(text, -1) {
		add(m[1])
	}
	for _, m := range quotedPathRegex.FindAllStringSubmatch(text, -1) {
		add(m[1])
	}
	for _, m := range barePathRegex.FindAllStringSubmatch(text, -1) {
		if strings.HasPrefix(m[1], "//") {
			continue
		}
		add(m[1])
	}
	return rtn
}

// existingMaterialPaths keeps the named paths that are existing files of a kept type.
func existingMaterialPaths(paths []string) []string {
	var rtn []string
	for _, p := range paths {
		if KindOfPath(p) == "" {
			continue
		}
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() {
			rtn = append(rtn, p)
		}
	}
	return rtn
}
