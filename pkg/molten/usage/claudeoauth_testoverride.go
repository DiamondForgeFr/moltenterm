// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build moltentestoverride

package usage

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"log"
	"net/url"
	"os"
)

// Test-only build (`-tags moltentestoverride`, never in a release or a gold): the real app runs against a local
// https server with a fake credentials file, so a test never reads the user's Keychain or token. Without the tag this
// file does not exist and the source reaches only Anthropic's endpoint.
func init() {
	endpoint := os.Getenv("MOLTENTERM_TEST_CLAUDE_USAGE_URL")
	if endpoint == "" {
		return
	}
	// Even a test build compiled in by mistake sends only a fake file's token, and only to this machine.
	if u, err := url.Parse(endpoint); err != nil || u.Scheme != "https" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		log.Printf("molten: TEST BUILD, Claude usage endpoint override refused: https on 127.0.0.1 or localhost only\n")
		return
	}
	pool := x509.NewCertPool()
	if pem, err := os.ReadFile(os.Getenv("MOLTENTERM_TEST_CLAUDE_USAGE_CA")); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	file := os.Getenv("MOLTENTERM_TEST_CLAUDE_CREDENTIALS")
	DefaultClaudeOAuthSource.override(ClaudeOAuthTestHooks{
		Endpoint: endpoint,
		Client:   makeOAuthClient(&tls.Config{RootCAs: pool}),
		Credentials: func(ctx context.Context) (string, int64, error) {
			return readClaudeCredentialsFile(file)
		},
		Store: func() string { return file },
	})
	log.Printf("molten: TEST BUILD, Claude usage endpoint overridden to %s\n", endpoint)
}
