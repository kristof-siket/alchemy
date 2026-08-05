import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  needsReauth,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "../../Auth/AuthProvider.ts";
import { validateFieldValues } from "../../Auth/StoredAuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../../Auth/Lock.ts";
import {
  getEnvRedacted,
  getEnvRequired,
  mapPromptCancellation,
} from "../../Auth/Env.ts";
import { browserOAuth } from "../../Auth/BrowserOAuth.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { CREDENTIALS_FILE as STATE_STORE_CREDENTIALS_FILE } from "../StateStore/CredentialsFile.ts";
import * as OAuthClient from "./OAuthClient.ts";

const options: Array<{
  value: CloudflareAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth",
    description:
      "recommended — browser-based login with automatic token refresh",
  },
  {
    value: "stored",
    label: "API Token or API Key",
    description:
      "enter credentials interactively, stored in ~/.alchemy/credentials",
  },
];

export type CloudflareAuthConfig =
  | { method: "stored"; credentialType: "apiToken" }
  | { method: "stored"; credentialType: "apiKey" }
  | { method: "oauth"; scopes: string[]; accountId: string };

/**
 * On-disk shape of the `method: "stored"` credentials persisted under
 * `~/.alchemy/credentials/{profile}/cloudflare-stored.json`.
 */
export const CloudflareStoredCredentials = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("apiToken"),
    apiToken: Schema.String,
    accountId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("apiKey"),
    apiKey: Schema.String,
    email: Schema.String,
    accountId: Schema.String,
  }),
]);
export type CloudflareStoredCredentials =
  typeof CloudflareStoredCredentials.Type;

/** Credential-store file keys (`~/.alchemy/credentials/{profile}/{key}.json`). */
const STORED_STORAGE_KEY = "cloudflare-stored";
const OAUTH_STORAGE_KEY = "cloudflare-oauth";

export type CloudflareResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "apiKey";
      apiKey: Redacted.Redacted<string>;
      email: Redacted.Redacted<string>;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      accountId: string;
      source: {
        type: CloudflareAuthConfig["method"] | "env";
        details?: string;
      };
    };

export const CLOUDFLARE_AUTH_PROVIDER_NAME = "Cloudflare";

const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    CfCredentialsModule.Credentials | HttpClient.HttpClient
  >,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      CfCredentialsModule.fromOAuth({
        load: Effect.succeed({ accessToken }),
        refresh: () =>
          Effect.die("refresh not expected during account selection"),
      }),
      FetchHttpClient.layer,
    ),
  );

const selectAccount = (accessToken: string) =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;
    if (accounts.length === 0) {
      return yield* new AuthError({
        message: "Cloudflare: no accounts found for this credential.",
      });
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      yield* prompt.info(
        `Cloudflare: using account: ${account.name} (${account.id})`,
      );
      return account.id;
    }
    return yield* prompt
      .select({
        message: "Select a Cloudflare account",
        options: accounts.map((a) => ({
          value: a.id,
          label: a.name,
          description: a.id,
        })),
      })
      .pipe(mapPromptCancellation);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

/**
 * Cloudflare account IDs are 32 lowercase hex characters. Placeholder
 * values ("", "-", "dummy", …) end up interpolated into API paths and
 * surface as baffling `InvalidRoute: Could not route to
 * /accounts/<value>/...` errors, so reject them up front with an
 * actionable message instead.
 */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

export const validateAccountId = (
  accountId: string | undefined,
  source: string,
): Effect.Effect<string, AuthError> => {
  const trimmed = accountId?.trim() ?? "";
  if (trimmed.length === 0) {
    return Effect.fail(
      new AuthError({
        message:
          `Cloudflare account ID is missing (${source}). ` +
          "Re-run 'alchemy profile edit --reconfigure Cloudflare' and provide your account ID " +
          "(found in the Cloudflare dashboard under Workers & Pages → Account details).",
      }),
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(trimmed)) {
    return Effect.fail(
      new AuthError({
        message:
          `'${trimmed}' is not a valid Cloudflare account ID (${source}) — expected 32 hex characters. ` +
          "Copy the account ID from the Cloudflare dashboard (Workers & Pages → Account details) " +
          "and re-run 'alchemy profile edit --reconfigure Cloudflare'.",
      }),
    );
  }
  return Effect.succeed(trimmed.toLowerCase());
};

/** Field-level validator reusing {@link ACCOUNT_ID_PATTERN}. */
const validateAccountIdField = (v: string): string | undefined =>
  ACCOUNT_ID_PATTERN.test(v.trim())
    ? undefined
    : "Expected a 32-character hex account ID (Workers & Pages → Account details)";

const promptAccountId = () =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    return yield* prompt
      .text({
        message: "Cloudflare Account ID",
        validate: validateAccountIdField,
      })
      .pipe(mapPromptCancellation);
  });

const accountIdField: ConfigureField = {
  name: "accountId",
  label: "Cloudflare Account ID",
  validate: validateAccountIdField,
};

/** `--set` fields for `--method api-token`. */
const apiTokenFields: ReadonlyArray<ConfigureField> = [
  { name: "apiToken", label: "Cloudflare API Token", secret: true },
  accountIdField,
];

/** `--set` fields for `--method api-key`. */
const apiKeyFields: ReadonlyArray<ConfigureField> = [
  { name: "apiKey", label: "Cloudflare API Key", secret: true },
  { name: "email", label: "Cloudflare Email" },
  accountIdField,
];

/**
 * Flag-driven configuration methods. OAuth is deliberately absent — it is
 * interactive-only (browser grant).
 */
const configureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "api-token", fields: apiTokenFields },
  { method: "api-key", fields: apiKeyFields },
];

const promptOAuthScopes = () =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const mode = yield* prompt
      .select({
        message: "Cloudflare OAuth scopes",
        options: [
          {
            value: "basic" as const,
            label: "Basic Scopes",
            description: "recommended — covers typical Alchemy use cases",
          },
          {
            value: "all" as const,
            label: "All Scopes",
            description: "authorize every available Cloudflare permission",
          },
          {
            value: "custom" as const,
            label: "Custom Scopes",
            description: "choose individual permissions",
          },
        ],
      })
      .pipe(mapPromptCancellation);
    if (mode === "basic") return [...BASIC_SCOPES];
    if (mode === "all") return [...ALL_SCOPE_IDS];
    return yield* prompt
      .multiSelect({
        message: "Select OAuth scopes",
        initialValues: [...BASIC_SCOPES],
        options: OAUTH_SCOPE_GROUPS.flatMap((group) =>
          group.scopes.map((value) => ({
            value,
            label: value,
            description: group.label,
          })),
        ),
        required: true,
      })
      .pipe(
        Effect.map((s) => s as string[]),
        mapPromptCancellation,
      );
  });

/**
 * Layer that registers the Cloudflare {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Cloudflare
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const CloudflareAuth = AuthProviderLayer<
  CloudflareAuthConfig,
  CloudflareResolvedCredentials
>()(
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const store = yield* CredentialsStore;

    const oauthLogin = (profileName: string, scopes: string[]) =>
      Effect.gen(function* () {
        const authorization = OAuthClient.authorize([
          ...scopes,
          "offline_access",
        ]);

        const credentials = yield* browserOAuth({
          provider: "Cloudflare",
          url: authorization.url,
          callback: OAuthClient.callback(authorization),
          exchange: (input) =>
            OAuthClient.exchangeCallbackInput(input, authorization),
        });
        yield* store.write(
          profileName,
          OAUTH_STORAGE_KEY,
          OAuthClient.OAuthCredentials,
          credentials,
        );
        yield* prompt.success("Cloudflare: OAuth credentials saved.");
        return credentials;
      });

    const loginStored = Effect.fn(function* (profileName: string) {
      const credentialType = yield* prompt
        .select({
          message: "Cloudflare credential type",
          options: [
            {
              value: "apiToken" as const,
              label: "API Token",
              description: "recommended",
            },
            { value: "apiKey" as const, label: "API Key + Email" },
          ],
        })
        .pipe(mapPromptCancellation);

      return yield* Match.value(credentialType).pipe(
        Match.when("apiToken", () =>
          Effect.gen(function* () {
            const apiToken = yield* prompt
              .password({
                message: "Cloudflare API Token",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation);
            const accountId = yield* promptAccountId();

            yield* store.write(
              profileName,
              STORED_STORAGE_KEY,
              CloudflareStoredCredentials,
              { type: "apiToken", apiToken, accountId },
            );
            yield* prompt.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiToken" as const,
            };
          }),
        ),
        Match.when("apiKey", () =>
          Effect.gen(function* () {
            const apiKey = yield* prompt
              .password({
                message: "Cloudflare API Key",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation);

            const email = yield* prompt
              .text({
                message: "Cloudflare Email",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation);
            const accountId = yield* promptAccountId();

            yield* store.write(
              profileName,
              STORED_STORAGE_KEY,
              CloudflareStoredCredentials,
              { type: "apiKey", apiKey, email, accountId },
            );
            yield* prompt.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiKey" as const,
            };
          }),
        ),
        Match.exhaustive,
      );
    });

    const configureOAuth = Effect.fn(function* (profileName: string) {
      const scopes = yield* promptOAuthScopes();

      const oauthCreds = yield* oauthLogin(profileName, scopes);

      const accountId = yield* selectAccount(oauthCreds.access).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "Cloudflare: could not list accounts",
              cause: e,
            }),
        ),
      );

      return {
        method: "oauth" as const,
        scopes,
        accountId,
      };
    });

    const configureInteractive = (profileName: string) =>
      prompt
        .select({
          message: "Cloudflare authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("oauth", () => configureOAuth(profileName)),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    const configureCredentials = (profileName: string) =>
      Effect.gen(function* () {
        const config = yield* configureInteractive(profileName);
        // Re-configuring auth may point this profile at a different
        // Cloudflare account. The cached state-store credentials
        // (`~/.alchemy/credentials/{profile}/cloudflare-state-store.json`)
        // are minted per-account, so drop them here; the next deploy
        // re-derives them against the freshly-configured account.
        yield* store
          .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
          .pipe(Effect.ignore);
        return config;
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: CloudflareAuthConfig,
    ): Effect.Effect<CloudflareResolvedCredentials, AuthError | NeedsReauth> =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, () =>
          store
            .read(profileName, STORED_STORAGE_KEY, CloudflareStoredCredentials)
            .pipe(
              Effect.flatMap(
                Effect.fn(function* (creds) {
                  if (creds == null) {
                    return yield* Effect.fail(
                      needsReauth({
                        provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        detail: "Cloudflare stored credentials not found.",
                      }),
                    );
                  }
                  const accountId = yield* validateAccountId(
                    creds.accountId,
                    `stored for profile '${profileName}'`,
                  );
                  return Match.value(creds).pipe(
                    Match.when({ type: "apiToken" }, (c) => ({
                      type: "apiToken" as const,
                      apiToken: Redacted.make(c.apiToken),
                      accountId,
                      source: { type: "stored" as const },
                    })),
                    Match.when({ type: "apiKey" }, (c) => ({
                      type: "apiKey" as const,
                      apiKey: Redacted.make(c.apiKey),
                      email: Redacted.make(c.email),
                      accountId,
                      source: { type: "stored" as const },
                    })),
                    Match.exhaustive,
                  );
                }),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, (cfg) =>
          Effect.gen(function* () {
            const accountId = yield* validateAccountId(
              cfg.accountId,
              `configured for profile '${profileName}'`,
            );
            const creds = yield* store.read(
              profileName,
              OAUTH_STORAGE_KEY,
              OAuthClient.OAuthCredentials,
            );
            if (creds == null || creds.type !== "oauth") {
              return yield* Effect.fail(
                needsReauth({
                  provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  detail: "Cloudflare OAuth credentials not found.",
                }),
              );
            }
            if (!OAuthClient.usesCurrentClient(creds)) {
              yield* store.delete(profileName, OAUTH_STORAGE_KEY);
              return yield* Effect.fail(
                needsReauth({
                  provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  detail: `Cloudflare OAuth credentials for profile '${profileName}' were issued to an incompatible OAuth client and have been removed.`,
                }),
              );
            }
            // Refresh proactively if the token has expired (or is within
            // 10s of expiring). Persist the refreshed creds so subsequent
            // resolves don't repeat the round-trip.
            const fresh =
              creds.expires > Date.now() + 10_000
                ? creds
                : yield* OAuthClient.refresh(creds).pipe(
                    Effect.tap((refreshed) =>
                      store.write(
                        profileName,
                        OAUTH_STORAGE_KEY,
                        OAuthClient.OAuthCredentials,
                        refreshed,
                      ),
                    ),
                    Effect.mapError((e) =>
                      needsReauth({
                        provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        detail: "Cloudflare OAuth refresh failed.",
                        cause: e,
                      }),
                    ),
                  );
            return {
              type: "oauth" as const,
              accessToken: Redacted.make(fresh.access),
              expires: fresh.expires,
              accountId,
              source: { type: "oauth" as const },
            };
          }),
        ),
        Match.exhaustive,
      );

    const readEnvironment = Effect.gen(function* () {
      const accountId = yield* getEnvRequired("CLOUDFLARE_ACCOUNT_ID").pipe(
        Effect.flatMap((id) =>
          validateAccountId(id, "from CLOUDFLARE_ACCOUNT_ID"),
        ),
      );
      const apiToken = yield* getEnvRedacted("CLOUDFLARE_API_TOKEN");
      if (apiToken) {
        return {
          type: "apiToken" as const,
          apiToken,
          accountId,
          source: { type: "env" as const },
        };
      }
      const apiKey = yield* getEnvRedacted("CLOUDFLARE_API_KEY");
      const email =
        (yield* getEnvRedacted("CLOUDFLARE_EMAIL")) ??
        (yield* getEnvRedacted("CLOUDFLARE_ACCOUNT_EMAIL"));
      if (apiKey && email) {
        return {
          type: "apiKey" as const,
          apiKey,
          email,
          accountId,
          source: { type: "env" as const },
        };
      }
      return yield* new AuthError({
        message:
          "Cloudflare CI credentials not found. Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL/CLOUDFLARE_ACCOUNT_EMAIL.",
      });
    });

    const logout = (profileName: string, config: CloudflareAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store
              .delete(profileName, STORED_STORAGE_KEY)
              .pipe(
                Effect.andThen(
                  prompt.success("Cloudflare: stored credentials removed"),
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              )
              .pipe(
                Effect.tap((creds) =>
                  creds?.type === "oauth" &&
                  OAuthClient.usesCurrentClient(creds)
                    ? OAuthClient.revoke(creds).pipe(
                        Effect.catchTag("OAuthError", (err) =>
                          prompt.warn(
                            `Cloudflare: could not revoke OAuth token: ${err.errorDescription}`,
                          ),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(store.delete(profileName, OAUTH_STORAGE_KEY)),
                Effect.andThen(
                  prompt.success("Cloudflare: OAuth credentials removed."),
                ),
              ),
          ),
          Match.exhaustive,
        )
        // The cached state-store credentials are derived from the account we
        // just logged out of, so drop them regardless of auth method.
        .pipe(
          Effect.andThen(
            store
              .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
              .pipe(Effect.ignore),
          ),
        );

    const login = (profileName: string, config: CloudflareAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store
              .read(
                profileName,
                STORED_STORAGE_KEY,
                CloudflareStoredCredentials,
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, (c) =>
            Effect.gen(function* () {
              const creds = yield* store.read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              );
              // Any path that falls back to a full browser login rebuilds the
              // authorize URL from the profile's stored scopes. Those scopes
              // may predate the current OAuth client (or a catalog change), and
              // one unknown scope makes the whole authorize URL invalid — so
              // sanitize before generating a URL, never after it fails.
              const fullLogin = Effect.suspend(() => {
                const { valid, dropped } = partitionOAuthScopes(c.scopes);
                if (valid.length === 0) {
                  return Effect.fail(
                    new AuthError({
                      message:
                        `The OAuth scopes stored for profile '${profileName}' are no longer offered by Alchemy's Cloudflare OAuth client. ` +
                        `Run \`alchemy profile edit ${profileName} --reconfigure Cloudflare\` to pick scopes again.`,
                    }),
                  );
                }
                return (
                  dropped.length === 0
                    ? Effect.void
                    : prompt.warn(
                        `Cloudflare: dropping ${dropped.length} stored scope${dropped.length === 1 ? "" : "s"} no longer offered by the current OAuth client (${dropped.join(", ")}). ` +
                          `Run \`alchemy profile edit ${profileName} --reconfigure Cloudflare\` to re-pick scopes.`,
                      )
                ).pipe(Effect.andThen(oauthLogin(profileName, valid)));
              });

              // The silent refresh rotates a single-use refresh token, so
              // its read-refresh-persist section runs under the profile
              // lock — a concurrent `read` refreshing the same token would
              // double-spend it. The lock is held only for this API
              // round-trip, never across the browser wait below.
              const outcome =
                creds?.type === "oauth" && OAuthClient.usesCurrentClient(creds)
                  ? yield* withProfileCredentialsLock(
                      profileName,
                      prompt
                        .info("Cloudflare: refreshing OAuth credentials...")
                        .pipe(
                          Effect.andThen(OAuthClient.refresh(creds)),
                          Effect.flatMap((refreshed) =>
                            store
                              .write(
                                profileName,
                                OAUTH_STORAGE_KEY,
                                OAuthClient.OAuthCredentials,
                                refreshed,
                              )
                              .pipe(
                                Effect.andThen(
                                  prompt.success(
                                    "Cloudflare: OAuth credentials refreshed.",
                                  ),
                                ),
                              ),
                          ),
                          Effect.as("refreshed" as const),
                          Effect.catchTag("OAuthError", () =>
                            Effect.succeed("browser" as const),
                          ),
                        ),
                    )
                  : yield* Effect.gen(function* () {
                      if (creds?.type === "oauth") {
                        yield* store.delete(profileName, OAUTH_STORAGE_KEY);
                        yield* prompt.warn(
                          "Cloudflare: removed OAuth credentials issued to the previous client.",
                        );
                      }
                      return "browser" as const;
                    });
              if (outcome === "browser") {
                yield* fullLogin;
              }
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          // A blanket mapError must never swallow the NeedsReauth tag —
          // the profile UI matches on it to render "needs re-login".
          Effect.mapError((e) =>
            e instanceof NeedsReauth
              ? e
              : new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const details = (
      profileName: string,
      config: CloudflareAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => {
          const source = {
            key: "source",
            value: creds.source.details
              ? `${creds.source.type} - ${creds.source.details}`
              : creds.source.type,
          };
          return {
            lines: Match.value(creds).pipe(
              Match.when({ type: "apiToken" }, (c) => [
                { key: "apiToken", value: displayRedacted(c.apiToken, 9) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "apiKey" }, (c) => [
                { key: "apiKey", value: displayRedacted(c.apiKey) },
                { key: "email", value: displayRedacted(c.email) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "oauth" }, (c) => {
                const remainingMs = c.expires - Date.now();
                const expiresAt = new Date(c.expires).toISOString();
                const expiresStr =
                  remainingMs <= 0
                    ? `expired (${expiresAt})`
                    : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
                return [
                  { key: "accessToken", value: displayRedacted(c.accessToken) },
                  { key: "expires", value: expiresStr },
                  { key: "accountId", value: c.accountId },
                  source,
                ];
              }),
              Match.exhaustive,
            ),
          };
        }),
      );

    /**
     * Persist flag-provided stored credentials (`--method api-token` /
     * `--method api-key`). Writes the same `cloudflare-stored` file the
     * interactive stored path writes; OAuth is interactive-only and not
     * accepted here.
     */
    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<CloudflareAuthConfig, AuthError> => {
      const persist = (
        credentials: CloudflareStoredCredentials,
        config: CloudflareAuthConfig,
      ) =>
        store
          .write(
            profileName,
            STORED_STORAGE_KEY,
            CloudflareStoredCredentials,
            credentials,
          )
          .pipe(
            // Re-configuring may point this profile at a different
            // Cloudflare account; the cached state-store credentials are
            // minted per-account, so drop them (same as `configure`).
            Effect.andThen(
              store
                .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
                .pipe(Effect.ignore),
            ),
            Effect.as(config),
          );
      return Match.value(input.method).pipe(
        Match.when("api-token", () =>
          validateFieldValues(
            CLOUDFLARE_AUTH_PROVIDER_NAME,
            apiTokenFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              persist(
                {
                  type: "apiToken",
                  apiToken: values.apiToken!,
                  accountId: values.accountId!.trim().toLowerCase(),
                },
                { method: "stored", credentialType: "apiToken" },
              ),
            ),
          ),
        ),
        Match.when("api-key", () =>
          validateFieldValues(
            CLOUDFLARE_AUTH_PROVIDER_NAME,
            apiKeyFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              persist(
                {
                  type: "apiKey",
                  apiKey: values.apiKey!,
                  email: values.email!,
                  accountId: values.accountId!.trim().toLowerCase(),
                },
                { method: "stored", credentialType: "apiKey" },
              ),
            ),
          ),
        ),
        Match.orElse(() =>
          Effect.fail(
            new AuthError({
              message: `Cloudflare: unknown method '${input.method}'. Valid methods: api-token, api-key. (OAuth is interactive-only.)`,
            }),
          ),
        ),
      );
    };

    return {
      configure: configureCredentials,
      configureWith,
      configureMethods,
      logout,
      login,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: "CLOUDFLARE_ACCOUNT_ID",
          required: true,
          description: "Account the stack deploys into.",
        },
        {
          name: "CLOUDFLARE_API_TOKEN",
          required: true,
          secret: true,
          description:
            "API token (preferred). Not consulted when unset and CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL are provided instead.",
        },
        {
          name: "CLOUDFLARE_API_KEY",
          required: false,
          secret: true,
          description:
            "Global API key; used with CLOUDFLARE_EMAIL when no API token is set.",
        },
        {
          name: "CLOUDFLARE_EMAIL",
          required: false,
          alternatives: ["CLOUDFLARE_ACCOUNT_EMAIL"],
          description: "Account email paired with CLOUDFLARE_API_KEY.",
        },
      ],
    };
  }),
);

/** Scopes enabled on Alchemy's public Cloudflare OAuth client. */
export const OAUTH_SCOPE_GROUPS = [
  {
    id: "developer-platform",
    label: "Developer Platform",
    scopes: [
      "agent-memory.write",
      "browser-rendering.read",
      "browser-rendering.write",
      "cf-agents.read",
      "cf-agents.write",
      "cloud-connector.read",
      "cloud-connector.write",
      "cloudchamber.read",
      "cloudchamber.write",
      "constellation.read",
      "constellation.write",
      "d1.read",
      "d1.write",
      "flagship.evaluate",
      "flagship.read",
      "flagship.write",
      "query-cache.read",
      "query-cache.write",
      "mcp-portals.read",
      "mcp-portals.write",
      "messaging.edit",
      "messaging.read",
      "page.read",
      "page.write",
      "pipelines.read",
      "pipelines.send",
      "pipelines.write",
      "pubsub.read",
      "pubsub.write",
      "queues.read",
      "queues.write",
      "realtime.admin",
      "realtime.read",
      "realtime.write",
      "secrets-store.read",
      "secrets-store.write",
      "vectorize.read",
      "vectorize.write",
      "workers-ci.read",
      "workers-ci.write",
      "containers.read",
      "containers.write",
      "workers-scripts.edit",
      "workers-kv-storage.read",
      "workers-kv-storage.write",
      "workers-observability.read",
      "workers-observability-telemetry.write",
      "workers-observability.write",
      "r2-catalog.read",
      "r2-catalog.write",
      "r2-catalog-sql.read",
      "workers-r2-bucket-item.read",
      "workers-r2-bucket-item.write",
      "workers-r2.read",
      "workers-r2.write",
      "workers-routes.read",
      "workers-routes.write",
      "workers-scripts.bind",
      "workers-scripts.read",
      "workers-scripts.write",
      "workers-tail.read",
    ],
  },
  {
    id: "ai-machine-learning",
    label: "AI & Machine Learning",
    scopes: [
      "aiaudit.read",
      "aiaudit.write",
      "aig.read",
      "aig.run",
      "aig.write",
      "ai-search.index",
      "ai-search.read",
      "ai-search.run",
      "ai-search.write",
      "agw.read",
      "agw.run",
      "agw.write",
      "rag.read",
      "rag.run",
      "rag.write",
      "firewall-for-ai.read",
      "firewall-for-ai.write",
      "websearch.read",
      "websearch.run",
      "websearch.write",
      "ai.read",
      "ai.write",
    ],
  },
  {
    id: "dns-zones",
    label: "DNS & Zones",
    scopes: [
      "account-dns-settings.read",
      "account-dns-settings.write",
      "dns-firewall.read",
      "dns-firewall.write",
      "dns.read",
      "dns-view.read",
      "dns-view.write",
      "dns.write",
      "registrar-domains.admin",
      "registrar-domains.read",
      "registrar-sandbox-domains.admin",
      "registrar-sandbox-domains.read",
      "zone-custom-asset.read",
      "zone-custom-asset.write",
      "zone-dns-settings.read",
      "zone-dns-settings.write",
      "zone.read",
      "zone-settings.read",
      "zone-settings.write",
      "zone-versioning.read",
      "zone-versioning.write",
      "zone.write",
    ],
  },
  {
    id: "app-security",
    label: "App Security",
    scopes: [
      "fraud-detection-pii.read",
      "account-firewall-access-rules.read",
      "account-firewall-access-rules.write",
      "account-security-center-insights.read",
      "account-security-center-insights.write",
      "account-waf.read",
      "account-waf.write",
      "request-tracer.read",
      "reports-application-security-report.read",
      "bot-management-feedback.read",
      "bot-management-feedback.write",
      "bot-management.read",
      "bot-management.write",
      "cloudforce-one.read",
      "cloudforce-one.write",
      "ddos-botnet-feed.read",
      "ddos-botnet-feed.write",
      "ddos-protection.read",
      "ddos-protection.write",
      "api-gateway.read",
      "api-gateway.write",
      "domain-page.shield",
      "domain-page-shield.read",
      "field-extractor.read",
      "field-extractor.write",
      "firewall-services.read",
      "firewall-services.write",
      "fraud-detection.read",
      "fraud-detection.write",
      "fraud-events.write",
      "fraud-feedback.read",
      "fraud-feedback.write",
      "http-applications.read",
      "http-applications.write",
      "http-ddos-managed-ruleset.read",
      "http-ddos-managed-ruleset.write",
      "iot.read",
      "iot.write",
      "l4-ddos-managed-ruleset.read",
      "l4-ddos-managed-ruleset.write",
      "page-rules.read",
      "page-rules.write",
      "page.shield",
      "page-shield.read",
      "precursor.read",
      "precursor.write",
      "sanitize.read",
      "sanitize.write",
      "tag.read",
      "tag.write",
      "trust-and-safety.read",
      "trust-and-safety.write",
      "challenge-widgets.read",
      "challenge-widgets.write",
      "url-scanner.read",
      "url-scanner.write",
      "zaraz.edit",
      "zaraz.read",
      "zaraz.write",
      "zone-security-center-insights.read",
      "zone-security-center-insights.write",
      "zone-waf.read",
      "zone-waf.write",
    ],
  },
  {
    id: "rules-configuration",
    label: "Rules & Configuration",
    scopes: [
      "account-custom-error-rules.read",
      "account-custom-error-rules.write",
      "account-custom-pages.read",
      "account-custom-pages.write",
      "account-rule-lists.read",
      "account-rule-lists.write",
      "account-rulesets.read",
      "account-rulesets.write",
      "config-settings.read",
      "config-settings.write",
      "custom-errors.read",
      "custom-errors.write",
      "custom-pages.read",
      "custom-pages.write",
      "dynamic-redirect.read",
      "dynamic-redirect.write",
      "managed-headers.read",
      "managed-headers.write",
      "mass-url-redirects.read",
      "mass-url-redirects.write",
      "origin.read",
      "origin.write",
      "payments-gateway.read",
      "payments-gateway.write",
      "response-compression.read",
      "response-compression.write",
      "select-configuration.read",
      "select-configuration.write",
      "snippets.read",
      "snippets.write",
      "transform-rules.read",
      "transform-rules.write",
      "zone-transform-rules.read",
      "zone-transform-rules.write",
    ],
  },
  {
    id: "zero-trust",
    label: "Cloudflare One / Zero Trust",
    scopes: [
      "access-app.read",
      "access-app.revoke",
      "access-app.write",
      "access.read",
      "zone-access.read",
      "access.revoke",
      "zone-access.revoke",
      "access.write",
      "zone-access.write",
      "access-audit-log.read",
      "access-custom-page.read",
      "access-custom-page.write",
      "access-device-posture.read",
      "access-device-posture.write",
      "access-group.read",
      "access-group.write",
      "access-idp.read",
      "access-idp.write",
      "access-key.read",
      "access-key.write",
      "access-certificate.read",
      "access-certificate.write",
      "access-org.read",
      "access-org.revoke",
      "access-org.write",
      "access-acct.read",
      "access-acct.revoke",
      "access-acct.write",
      "access-policy.read",
      "access-policy.write",
      "access-policy-test.read",
      "access-policy-test.write",
      "access-population.read",
      "access-population.write",
      "access-saml-certificate.read",
      "access-saml-certificate.write",
      "access-scim-log.read",
      "access-ssh-auditing.read",
      "access-ssh-auditing.write",
      "access-service-token.read",
      "access-service-token.write",
      "access-tag.read",
      "access-tag.write",
      "access-users.read",
      "access-users.write",
      "casb.read",
      "casb.write",
      "teams-cds-compute-account.read",
      "teams-cds-compute-account.write",
      "teams-dex.read",
      "teams-dex.write",
      "teams-connector-cloudflared.monitoring",
      "teams-connector-warp.read",
      "teams-connector-warp.write",
      "teams-connector-cloudflared.read",
      "teams-connector-cloudflared.write",
      "teams-connectors.read",
      "teams-connectors.write",
      "teams-networks.read",
      "teams-networks.write",
      "argotunnel.read",
      "argotunnel.write",
      "teams-secure.location",
      "dls.read",
      "dls.write",
      "teams.read",
      "teams.report",
      "teams-resilience.read",
      "teams-resilience.write",
      "teams.write",
      "teams-pii.read",
      "access-seats.write",
    ],
  },
  {
    id: "analytics-logs",
    label: "Analytics & Logs",
    scopes: [
      "account-analytics.read",
      "analytics.read",
      "intel.read",
      "intel.write",
      "account-logs.read",
      "account-logs.write",
      "logs.read",
      "logs.write",
      "radar.read",
    ],
  },
  {
    id: "network-services",
    label: "Network Services",
    scopes: [
      "account-waiting-rooms.read",
      "address-maps.read",
      "address-maps.write",
      "chinanetwork-steering.read",
      "chinanetwork-steering.write",
      "connectivity-directory.admin",
      "connectivity-directory.bind",
      "connectivity-directory.read",
      "healthcheck.read",
      "healthcheck.write",
      "ip-prefix-bgp-on-demand.read",
      "ip-prefix-bgp-on-demand.write",
      "ip-prefix.read",
      "ip-prefix.write",
      "load-balancers-account.read",
      "load-balancers-account.write",
      "load-balancers.read",
      "load-balancers.write",
      "load-balancing-monitors-and-pools.read",
      "load-balancing-monitors-and-pools.write",
      "pcaps-api.read",
      "pcaps-api.write",
      "magic-firewall.read",
      "magic-firewall.write",
      "fbm.admin",
      "fbm.read",
      "fbm.write",
      "magic-transit.read",
      "magic-transit.write",
      "magic-wan.read",
      "magic-wan.write",
      "waiting-rooms.read",
      "waiting-rooms.write",
      "web3-hostnames.read",
      "web3-hostnames.write",
    ],
  },
  {
    id: "media",
    label: "Media",
    scopes: [
      "calls.read",
      "calls.write",
      "images.read",
      "images.write",
      "moq.read",
      "moq.write",
      "stream.read",
      "stream.write",
    ],
  },
  {
    id: "email-messaging",
    label: "Email & Messaging",
    scopes: [
      "cloud-email-security.read",
      "cloud-email-security.write",
      "email-routing-account-rule.read",
      "email-routing-address.read",
      "email-routing-address.write",
      "email-routing-rule.read",
      "email-routing-rule.write",
      "email-routing-suppression.read",
      "email-routing-suppression.write",
      "email-security-dmarcreports.read",
      "email-security-dmarcreports.write",
      "email-sending.read",
      "email-sending.write",
    ],
  },
  {
    id: "cache-performance",
    label: "Cache & Performance",
    scopes: [
      "account-ssl-and-certificates.read",
      "account-ssl-and-certificates.write",
      "cache.purge",
      "cache-settings.read",
      "cache-settings.write",
      "account-disable-esc.read",
      "account-disable-esc.write",
      "zone-disable-esc.read",
      "zone-disable-esc.write",
      "ssl-and-certificates.read",
      "ssl-and-certificates.write",
    ],
  },
  {
    id: "account-billing",
    label: "Account & Billing",
    scopes: [
      "account-api-gateway.read",
      "account-api-gateway.write",
      "account-custom-asset.read",
      "account-custom-asset.write",
      "account-settings.read",
      "account-settings.write",
      "apps.write",
      "integration.write",
      "memberships.read",
      "memberships.write",
      "notifications.read",
      "notifications.write",
      "scim-provisioning.write",
      "user-details.read",
      "user-details.write",
    ],
  },
  {
    id: "other",
    label: "Other",
    scopes: [
      "artifacts.read",
      "artifacts.write",
      "resource-library.read",
      "resource-library.write",
      "resource-sharing.read",
    ],
  },
] as const;

export type OAuthScopeId =
  (typeof OAUTH_SCOPE_GROUPS)[number]["scopes"][number];

/** Flat lookup retained for consumers that do not need grouping metadata. */
export const ALL_SCOPES = Object.fromEntries(
  OAUTH_SCOPE_GROUPS.flatMap((group) =>
    group.scopes.map((scope) => [scope, group.label]),
  ),
) as Readonly<Record<OAuthScopeId, string>>;

/** Every scope available to the public Alchemy OAuth client. */
export const ALL_SCOPE_IDS: ReadonlyArray<OAuthScopeId> =
  OAUTH_SCOPE_GROUPS.flatMap((group) => group.scopes);

/**
 * Split stored scopes into those the current OAuth client offers and those
 * it does not. Profiles configured against an older client (or scope
 * catalog) can hold scopes the current client rejects, and a single unknown
 * scope invalidates the entire authorize URL — sanitize with this before
 * building one.
 */
export const partitionOAuthScopes = (
  scopes: ReadonlyArray<string>,
): { valid: string[]; dropped: string[] } => {
  const known = new Set<string>(ALL_SCOPE_IDS);
  return {
    valid: scopes.filter((scope) => known.has(scope)),
    dropped: scopes.filter((scope) => !known.has(scope)),
  };
};

/** Reusable scope bundles for common OAuth authorization flows. */
export const OAUTH_SCOPE_TEMPLATES = {
  basic: [
    "memberships.read",
    "user-details.read",
    "account-settings.read",
    "ai-search.run",
    "ai-search.write",
    "ai.write",
    "aig.read",
    "aig.run",
    "aig.write",
    "cloudchamber.write",
    "connectivity-directory.admin",
    "containers.write",
    "d1.write",
    "page.write",
    "pipelines.send",
    "pipelines.write",
    "queues.write",
    "secrets-store.write",
    "account-ssl-and-certificates.write",
    "ssl-and-certificates.write",
    "vectorize.write",
    "workers-kv-storage.write",
    "workers-observability.read",
    "workers-observability.write",
    "workers-observability-telemetry.write",
    "workers-r2.write",
    "workers-routes.write",
    "workers-scripts.write",
    "workers-tail.read",
    "zone.read",
  ],
} as const satisfies Readonly<Record<string, ReadonlyArray<OAuthScopeId>>>;

export const BASIC_SCOPES: ReadonlyArray<OAuthScopeId> =
  OAUTH_SCOPE_TEMPLATES.basic;
