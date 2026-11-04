// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHub not answering (a 5xx, a timeout, the network) is not a decision on the PR (#1871): Validate's calls that
// change nothing when they did not get through are tried again a few times, a little later each time, before the
// merge stops. A status GitHub means (4xx: a conflict, a head that moved, a rule) is never tried again.

const (
	// MergeCodeUnavailable: GitHub did not answer, even after the tries again; MergeRecord.Status is its HTTP status
	// (0 for a timeout or a network error).
	MergeCodeUnavailable = "unavailable"
)

// ghRetryDelays: the waits before each new try, about a minute and a half in all (three tries).
var ghRetryDelays = []time.Duration{20 * time.Second, 60 * time.Second}

var ghStatusPattern = regexp.MustCompile(`(?i)\bHTTP\s*([1-5]\d\d)\b|status code:?\s*([1-5]\d\d)\b|\b(5\d\d)\s+(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)`)

// What gh and Go say when GitHub was not reached or did not answer in time, or when GitHub's GraphQL failed on its
// side.
var ghTransientWords = []string{
	"timeout",
	"timed out",
	"deadline exceeded",
	"connection reset",
	"connection refused",
	"broken pipe",
	"no such host",
	"network is unreachable",
	"could not resolve host",
	"tls handshake",
	"unexpected eof",
	"something went wrong while executing your query",
}

// ghStatusOf: the HTTP status a gh error names, 0 when it names none.
func ghStatusOf(text string) int {
	m := ghStatusPattern.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	for _, s := range m[1:] {
		if s != "" {
			n, _ := strconv.Atoi(s)
			return n
		}
	}
	return 0
}

// ghTransient tells whether a gh error is GitHub not answering, and its HTTP status (0 for a timeout or a network
// error). A 4xx is GitHub's answer, never transient, whatever else the error says.
func ghTransient(text string) (int, bool) {
	if status := ghStatusOf(text); status != 0 {
		return status, status >= 500
	}
	lower := strings.ToLower(text)
	for _, w := range ghTransientWords {
		if strings.Contains(lower, w) {
			return 0, true
		}
	}
	return 0, false
}

// retryGh runs call, then again after each of the Merger's delays while GitHub does not answer. settled, when given,
// is asked before each new try: the call may have got through although its answer did not (a 502 after the merge),
// and true ends the tries as a success.
func (m *Merger) retryGh(ctx context.Context, k PrKey, what string, call func() error, settled func() bool) error {
	err := call()
	for i := 0; err != nil && i < len(m.retryDelays); i++ {
		if ctx.Err() != nil {
			return err
		}
		if _, ok := ghTransient(err.Error()); !ok {
			return err
		}
		log.Printf("%s %s#%d: GitHub did not answer the %s, trying again in %s: %s\n", logPrefix, k.Repo, k.Number, what, m.retryDelays[i], maskTokens(err.Error()))
		if !m.sleep(ctx, m.retryDelays[i]) {
			return err
		}
		if settled != nil && settled() {
			return nil
		}
		err = call()
	}
	return err
}

// endGh ends the merge on a gh error: GitHub not answering is said as such, with its status; any other error keeps
// the code given.
func (m *Merger) endGh(k PrKey, record MergeRecord, code string, err error) MergeRecord {
	if status, ok := ghTransient(err.Error()); ok {
		record.Status = status
		return m.end(k, record, MergeFailed, "", MergeCodeUnavailable, err)
	}
	return m.end(k, record, MergeFailed, "", code, err)
}
