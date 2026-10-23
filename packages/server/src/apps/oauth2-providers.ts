// OAuth2 providers that `auth: { type: 'oauth2', provider }` can name.
//
// Each install registers its own OAuth app with the provider and sets
// `<PROVIDER>_INTEGRATION_CLIENT_ID` and `<PROVIDER>_INTEGRATION_CLIENT_SECRET`
// (e.g. GOOGLE_INTEGRATION_CLIENT_ID). Apps whose provider has no credentials
// are hidden from the integrations list.
//
// The redirect URI to register with every provider is
// `${APP_HOMEPAGE_URL}/api/integrations/oauth/callback`.

export interface OAuth2Provider {
  id: string
  // Shown on the connect button, e.g. "Connect Google account"
  name: string
  authorizeUrl: string
  tokenUrl: string
  // Extra query parameters for the authorize URL
  authorizeParams?: Record<string, string>
  // Send a PKCE code challenge (RFC 7636) with the authorize request
  pkce?: boolean
  // OpenID Connect userinfo endpoint, which identifies the connected account
  // (`sub`, and `email` / `name` when granted). Connections are per account,
  // so it's required.
  userInfoUrl: string
  // Requested with every app's scopes, so the userinfo endpoint answers
  identityScopes: string[]
  // Token revocation endpoint (RFC 7009). When set, the grant is revoked
  // there, best effort, when the team disconnects the account.
  revokeUrl?: string
}

export interface OAuth2ProviderCredentials {
  clientId: string
  clientSecret: string
}

export type ConfiguredOAuth2Provider = OAuth2Provider & OAuth2ProviderCredentials

export const google: OAuth2Provider = {
  id: 'google',
  name: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  identityScopes: ['openid', 'email'],
  // Revokes the whole grant: every token issued to this server's OAuth client
  // for the account, not only the token sent
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  authorizeParams: {
    // Google only returns a refresh token for offline access, and only on the
    // consent screen, so ask for consent on every connect
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  },
  pkce: true
}

export const oauth2Providers: Record<string, OAuth2Provider> = {
  google
}

export function oauth2CredentialsEnvNames(providerId: string) {
  const prefix = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')

  return {
    clientId: `${prefix}_INTEGRATION_CLIENT_ID`,
    clientSecret: `${prefix}_INTEGRATION_CLIENT_SECRET`
  }
}

export function readOAuth2Credentials(
  providerId: string,
  env: Record<string, string | undefined> = process.env
): OAuth2ProviderCredentials | undefined {
  const names = oauth2CredentialsEnvNames(providerId)
  const clientId = env[names.clientId]?.trim()
  const clientSecret = env[names.clientSecret]?.trim()

  if (clientId && clientSecret) {
    return { clientId, clientSecret }
  }
}
