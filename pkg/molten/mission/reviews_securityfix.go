// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// The fixes of the shared security blocks (FR-REV-036 AC9 to AC13, #2589). The launcher in pkg/molten/review writes them
// and follows them; the Integration list reads them with the answer (securityfixes), and the work that follows a merged
// fix reads them through LiveSecurityFixes.

// SecurityFixesFileName is where the fixes are kept, in the cache folder.
const SecurityFixesFileName = "security-fixes.json"

// securityFixesShownFor is how long a fix that ended stays in the answer: the panel says what it did (the merge, the stop)
// for a while, then lets it go.
const securityFixesShownFor = 48 * time.Hour

// SecurityAssessed is what one assessment of a project's failed scans found: the work that follows a shared block (the
// fix launcher) reads it as it is made, instead of waiting for a window to read the list.
type SecurityAssessed struct {
	Dir string
	// Repo is the repository as gh names it (owner/name); Trunk the branch the listed pull requests target.
	Repo   string
	Trunk  string
	Result secfix.Result
}

var securityObserver atomic.Pointer[func(SecurityAssessed)]

// SetSecurityObserver registers what is told of each assessment; one observer, the fix launcher's. nil removes it.
func SetSecurityObserver(observe func(SecurityAssessed)) {
	if observe == nil {
		securityObserver.Store(nil)
		return
	}
	securityObserver.Store(&observe)
}

func notifySecurityObserver(assessed SecurityAssessed) {
	if observe := securityObserver.Load(); observe != nil {
		(*observe)(assessed)
	}
}

// fixesShown are the project's fixes the answer carries: those in flight, and those that ended lately.
func (r *Reviews) fixesShown(dir string) []secfix.Fix {
	fixes := []secfix.Fix{}
	if r == nil || r.securityFixes == nil {
		return fixes
	}
	cutoff := r.now().Add(-securityFixesShownFor).UnixMilli()
	for _, fix := range r.securityFixes.List(filepath.Clean(dir)) {
		if fix.Active() || fix.UpdatedAt >= cutoff {
			fixes = append(fixes, fix)
		}
	}
	return fixes
}

// SecurityDeclaration is the project's `ci.security` declaration; nil when it declares none or it has problems.
func SecurityDeclaration(dir string) *secfix.Declaration {
	return readSecurityDeclaration(dir)
}

// SecurityFixes is the store the launcher keeps the fixes in; nil when Mission Control is not started.
func (r *Reviews) SecurityFixes() *secfix.FixStore {
	if r == nil {
		return nil
	}
	return r.securityFixes
}

// LiveSecurityFixes is SecurityFixes on the running Mission Control.
func LiveSecurityFixes() *secfix.FixStore {
	return liveReviews().SecurityFixes()
}

// LiveSecurityFixesChanged tells the views that a project's fixes changed: the list is published again.
func LiveSecurityFixesChanged(dir string) {
	if r := liveReviews(); r != nil {
		r.publishCurrent(filepath.Clean(dir))
	}
}
