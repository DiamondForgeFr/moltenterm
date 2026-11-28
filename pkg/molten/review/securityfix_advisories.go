// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// What the advisory database says of the ids a scan names (FR-REV-036 AC9, #2589). The text of a scan's report or log is
// written by the CI job of a pull request, so it never decides which package an agent touches or to which version: the ids
// are looked up in the GitHub Advisory Database (a GHSA id) or in OSV (every other id, the Go vulnerability database's
// among them), and the ticket and the brief carry what the database says.

const (
	securityAdvisoryTtl   = time.Hour
	securityLookupTimeout = 20 * time.Second
	// A set of more advisories than this is not one fixable set: the rest is shown as the scan named it, and a fix that
	// starts on its own never starts for one.
	securityMaxVerified = 30
	osvVulnsUrl         = "https://api.osv.dev/v1/vulns/"
	// maxAdvisoryAnswer bounds what a database's answer may weigh.
	maxAdvisoryAnswer = 1 << 20
)

// advisoryAnswer is what the database answered for an id, and when.
type advisoryAnswer struct {
	at      time.Time
	entries []secfix.Advisory
	found   bool
}

// lookupAdvisory asks the advisory database for an id, at most once an hour per id. An error is a database that could not
// be read, never an id it does not know.
func (r *Restarter) lookupAdvisory(ctx context.Context, id string) ([]secfix.Advisory, bool, error) {
	look := r.env.SecurityFix.Lookup
	if look == nil {
		return nil, false, errors.New("no advisory database can be read here")
	}
	now := r.env.Now()
	r.lock.Lock()
	hit, cached := r.secDb[id]
	r.lock.Unlock()
	if cached && now.Sub(hit.at) < securityAdvisoryTtl {
		return hit.entries, hit.found, nil
	}
	ctx, cancel := context.WithTimeout(ctx, securityLookupTimeout)
	defer cancel()
	entries, found, err := look(ctx, id)
	if err != nil {
		return nil, false, err
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.secDb == nil {
		r.secDb = map[string]advisoryAnswer{}
	}
	r.secDb[id] = advisoryAnswer{at: now, entries: entries, found: found}
	return entries, found, nil
}

// securityVerify gives the block's advisories as the database says them, one entry per package an advisory affects, and the
// ids it does not know (shown as the scan named them: the id alone, no package, no version). An error means the database
// could not be read.
func (r *Restarter) securityVerify(ctx context.Context, in securityLaunch) ([]secfix.Advisory, []string, error) {
	var verified []secfix.Advisory
	var unverified []string
	for i, id := range secfix.Ids(in.block.Advisories) {
		if i >= securityMaxVerified {
			unverified = append(unverified, id)
			verified = append(verified, secfix.Advisory{Id: id})
			continue
		}
		entries, found, err := r.lookupAdvisory(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		if !found || len(entries) == 0 {
			unverified = append(unverified, id)
			verified = append(verified, secfix.Advisory{Id: id})
			continue
		}
		verified = append(verified, entries...)
	}
	return verified, unverified, nil
}

// liveAdvisoryLookup reads the advisory database: GitHub's for a GHSA id (through the developer's gh), OSV's for any other.
// Only the id leaves the computer, never anything of the project.
func liveAdvisoryLookup(ctx context.Context, id string) ([]secfix.Advisory, bool, error) {
	id = secfix.NormalizeId(id)
	if id == "" {
		return nil, false, errors.New("the advisory's id is not a plain identifier")
	}
	if secfix.IsGithubId(id) {
		out, err := ExecGh(ctx, os.TempDir(), "api", "/advisories/"+id)
		if err != nil {
			if strings.Contains(err.Error()+string(out), "404") {
				return nil, false, nil
			}
			return nil, false, fmt.Errorf("GitHub's advisory database could not be read: %w", err)
		}
		entries, err := secfix.ParseGithubAdvisory(id, out)
		if err != nil {
			return nil, false, err
		}
		return entries, true, nil
	}
	return fetchOsvAdvisory(ctx, &http.Client{Timeout: securityLookupTimeout}, osvVulnsUrl, id)
}

// fetchOsvAdvisory reads one entry of OSV (base is the vulns endpoint, a test's server in the tests).
func fetchOsvAdvisory(ctx context.Context, client *http.Client, base string, id string) ([]secfix.Advisory, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+url.PathEscape(id), nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("the advisory database could not be read: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("the advisory database answered %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxAdvisoryAnswer))
	if err != nil {
		return nil, false, fmt.Errorf("the advisory database could not be read: %w", err)
	}
	entries, err := secfix.ParseOsvAdvisory(id, data)
	if err != nil {
		return nil, false, err
	}
	return entries, true, nil
}
