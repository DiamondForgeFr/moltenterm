// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	kimiManagedProvider    = "managed:kimi-code"
	kimiManagedModel       = "kimi-code/"
	kimiManagedOAuthPrefix = "oauth/"
	kimiManagedOAuthHost   = "https://auth.kimi.com"
	kimiManagedBaseURL     = "https://api.kimi.com/coding/v1"
)

type kimiRegion struct {
	oauthHost     string
	baseURL       string
	usageEndpoint string
	pageURL       string
	domain        string
}

var kimiRegions = []kimiRegion{
	{kimiManagedOAuthHost, kimiManagedBaseURL, KimiUsageEndpoint, KimiUsagePageURL, "kimi.com"},
	{"https://auth.kimi.ai", "https://api.kimi.ai/coding/v1", KimiAIUsageEndpoint, KimiAIUsagePageURL, "kimi.ai"},
}

type kimiManagedConnection struct {
	credentialPath string
	usageEndpoint  string
	pageURL        string
	domain         string
}

type kimiManagedConfig struct {
	DefaultModel string                    `toml:"default_model"`
	Providers    map[string]kimiProvider   `toml:"providers"`
	Models       map[string]kimiModelAlias `toml:"models"`
}

type kimiProvider struct {
	BaseURL string        `toml:"base_url"`
	OAuth   *kimiOAuthRef `toml:"oauth"`
}

type kimiOAuthRef struct {
	Storage   string `toml:"storage"`
	Key       string `toml:"key"`
	OAuthHost string `toml:"oauth_host"`
}

type kimiModelAlias struct {
	Provider string `toml:"provider"`
}

type kimiEnvironment func(string) (string, bool)

func kimiHome(getenv kimiEnvironment, home string) string {
	if dir, ok := getenv("KIMI_CODE_HOME"); ok && dir != "" {
		return dir
	}
	return filepath.Join(home, ".kimi-code")
}

func kimiCredentialPath(getenv kimiEnvironment, home string) string {
	return filepath.Join(kimiHome(getenv, home), "credentials", "kimi-code.json")
}

func validKimiCredentialName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		alpha := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		digit := c >= '0' && c <= '9'
		if !alpha && !digit && (i == 0 || c != '.' && c != '-' && c != '_') {
			return false
		}
	}
	return true
}

func kimiCredentialPathForKey(getenv kimiEnvironment, home string, key string) (string, bool) {
	name, ok := strings.CutPrefix(strings.TrimSpace(key), kimiManagedOAuthPrefix)
	if !ok || !validKimiCredentialName(name) {
		return "", false
	}
	return filepath.Join(kimiHome(getenv, home), "credentials", name+".json"), true
}

func kimiConfigPath(getenv kimiEnvironment, home string) string {
	return filepath.Join(kimiHome(getenv, home), "config.toml")
}

func currentKimiCredentialPath() string {
	home, _ := os.UserHomeDir()
	return kimiCredentialPath(os.LookupEnv, home)
}

func kimiCredentialStore() string {
	home, _ := os.UserHomeDir()
	path := currentKimiCredentialPath()
	if connection, err := currentKimiManagedConnection(); err == nil {
		path = connection.credentialPath
	}
	if dir, ok := os.LookupEnv("KIMI_CODE_HOME"); (ok && dir != "") || home == "" {
		return path
	}
	if strings.HasPrefix(path, home+string(filepath.Separator)) {
		return "~" + path[len(home):]
	}
	return path
}

func normalizeKimiManagedURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func configuredKimiURL(configured string, defaultValue string, getenv kimiEnvironment, names ...string) string {
	for _, name := range names {
		if value, ok := getenv(name); ok {
			return normalizeKimiManagedURL(value)
		}
	}
	if normalizeKimiManagedURL(configured) == "" {
		return defaultValue
	}
	return normalizeKimiManagedURL(configured)
}

// readKimiManagedConfigAt decodes no API keys or credential environment entries. Their fields are absent from the
// config structs, and a provider is eligible only through its explicit file-backed OAuth reference on an official region.
func readKimiManagedConfigAt(path string, getenv kimiEnvironment, home string) (kimiManagedConnection, error) {
	data, err := readBoundedRegularFile(path, maxCredentialsBytes)
	if err != nil {
		if errors.Is(err, errNoCredentials) {
			return kimiManagedConnection{}, Unavailable(ReasonSignedOut)
		}
		return kimiManagedConnection{}, err
	}
	var doc kimiManagedConfig
	if _, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&doc); err != nil {
		return kimiManagedConnection{}, Unavailable(ReasonFormat)
	}
	if doc.DefaultModel == "" {
		return kimiManagedConnection{}, Unavailable(ReasonSignedOut)
	}
	alias, ok := doc.Models[doc.DefaultModel]
	if !ok || alias.Provider != kimiManagedProvider || !strings.HasPrefix(doc.DefaultModel, kimiManagedModel) {
		return kimiManagedConnection{}, Unavailable(ReasonUnsupported)
	}
	provider, ok := doc.Providers[kimiManagedProvider]
	if !ok || provider.OAuth == nil || provider.OAuth.Storage != "file" {
		return kimiManagedConnection{}, Unavailable(ReasonUnsupported)
	}
	credentialPath, ok := kimiCredentialPathForKey(getenv, home, provider.OAuth.Key)
	if !ok {
		return kimiManagedConnection{}, Unavailable(ReasonUnsupported)
	}
	oauthHost := configuredKimiURL(provider.OAuth.OAuthHost, kimiManagedOAuthHost, getenv, "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST")
	baseURL := configuredKimiURL(provider.BaseURL, kimiManagedBaseURL, getenv, "KIMI_CODE_BASE_URL")
	for _, region := range kimiRegions {
		if oauthHost == region.oauthHost && baseURL == region.baseURL {
			return kimiManagedConnection{
				credentialPath: credentialPath,
				usageEndpoint:  region.usageEndpoint,
				pageURL:        region.pageURL,
				domain:         region.domain,
			}, nil
		}
	}
	return kimiManagedConnection{}, Unavailable(ReasonUnsupported)
}

func currentKimiManagedConnection() (kimiManagedConnection, error) {
	home, _ := os.UserHomeDir()
	return readKimiManagedConfigAt(kimiConfigPath(os.LookupEnv, home), os.LookupEnv, home)
}

func checkKimiManagedConfigAt(path string, getenv kimiEnvironment) error {
	_, err := readKimiManagedConfigAt(path, getenv, "")
	return err
}

func checkKimiManagedConfiguration() error {
	_, err := currentKimiManagedConnection()
	return err
}

func currentKimiUsagePageURL() string {
	if connection, err := currentKimiManagedConnection(); err == nil {
		return connection.pageURL
	}
	return KimiUsagePageURL
}

func currentKimiDomain() string {
	if connection, err := currentKimiManagedConnection(); err == nil {
		return connection.domain
	}
	return "kimi.com"
}

func parseKimiCredentials(data []byte) (string, int64, error) {
	var doc struct {
		AccessToken *string  `json:"access_token"`
		ExpiresAt   *float64 `json:"expires_at"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", 0, Unavailable(ReasonFormat)
	}
	if doc.AccessToken == nil || strings.TrimSpace(*doc.AccessToken) == "" {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	token := strings.TrimSpace(*doc.AccessToken)
	if !validBearer(token) {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	if doc.ExpiresAt == nil || *doc.ExpiresAt == 0 {
		return token, 0, nil
	}
	seconds := *doc.ExpiresAt
	if seconds < 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds >= float64(math.MaxInt64)/1000 {
		return "", 0, Unavailable(ReasonFormat)
	}
	milliseconds := seconds * 1000
	if milliseconds >= float64(math.MaxInt64) {
		return "", 0, Unavailable(ReasonFormat)
	}
	return token, int64(milliseconds), nil
}

func readKimiCredentialsFile(path string) (string, int64, error) {
	data, err := readBoundedRegularFile(path, maxCredentialsBytes)
	if err != nil {
		if errors.Is(err, errNoCredentials) {
			return "", 0, Unavailable(ReasonSignedOut)
		}
		return "", 0, err
	}
	defer zero(data)
	return parseKimiCredentials(data)
}

func readKimiCredentials(ctx context.Context) (string, int64, error) {
	connection, ok := ctx.Value(kimiConnectionContextKey{}).(kimiManagedConnection)
	if !ok {
		var err error
		connection, err = currentKimiManagedConnection()
		if err != nil {
			return "", 0, err
		}
	}
	return readKimiCredentialsFile(connection.credentialPath)
}
