import { BadRequestException, Injectable } from '@nestjs/common'
import * as crypto from 'crypto'
import got from 'got'

import { AppService } from './app.service'
import { IntegrationService } from './integration.service'
import { RedisService } from './redis.service'
import { ThirdPartyService } from './third-party.service'
import { APP_HOMEPAGE_URL, FORM_ENCRYPTION_KEY } from '@environments'
import { IntegrationModel, IntegrationStatusEnum, ThirdPartyOauthModel } from '@model'
import { Logger, decryptSecret, encryptSecret, mapToObject } from '@utils'

import { ConfiguredOAuth2Provider } from '../apps/oauth2-providers'
import { AppDefinition, AppRunAuth } from '../apps/types'

export const INTEGRATION_OAUTH_CALLBACK_PATH = '/api/integrations/oauth/callback'

const STATE_TTL = '10m'
const TOKEN_REQUEST_TIMEOUT = 15_000
// Refresh a little before the provider's expiry, so a token doesn't expire
// between being handed to run() and being used
const EXPIRY_MARGIN = 60_000

/**
 * A credential problem that retrying won't fix: the job fails without further
 * attempts. `needsReconnect` means the form owner has to connect the account
 * again, and the integration has been marked so.
 */
export class IntegrationAuthError extends Error {
  constructor(
    message: string,
    readonly needsReconnect = false
  ) {
    super(message)
    this.name = 'IntegrationAuthError'
  }
}

// A token endpoint error. `code` is the OAuth2 error code (RFC 6749 §5.2) when
// the provider sent one. Messages never include tokens or the response body.
export class OAuth2TokenError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'OAuth2TokenError'
  }
}

interface OAuth2TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

interface StoredTokens {
  accessToken?: string
  refreshToken?: string
  // Milliseconds since the epoch
  expiresAt?: number
}

export interface IntegrationOAuthState {
  appId: string
  formId: string
  userId: string
  codeVerifier?: string
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function maskApiKey(apiKey: string): string {
  // Only show the end of keys long enough that four characters give little away
  return apiKey.length >= 16 ? `••••${apiKey.slice(-4)}` : '••••'
}

@Injectable()
export class IntegrationAuthService {
  private readonly logger = new Logger(IntegrationAuthService.name)

  constructor(
    private readonly appService: AppService,
    private readonly integrationService: IntegrationService,
    private readonly thirdPartyService: ThirdPartyService,
    private readonly redisService: RedisService
  ) {}

  get redirectUri(): string {
    return new URL(INTEGRATION_OAUTH_CALLBACK_PATH, APP_HOMEPAGE_URL).toString()
  }

  // --- API keys ---------------------------------------------------------------

  encryptApiKey(apiKey: string): Pick<IntegrationModel, 'apiKey' | 'apiKeyHint'> {
    return {
      apiKey: encryptSecret(apiKey, FORM_ENCRYPTION_KEY),
      apiKeyHint: maskApiKey(apiKey)
    }
  }

  // --- OAuth2 connect flow ----------------------------------------------------

  private stateKey(state: string): string {
    return `integration_oauth_state:${state}`
  }

  private requireProvider(app: AppDefinition): ConfiguredOAuth2Provider {
    const provider = this.appService.findOAuth2Provider(app)

    if (!provider) {
      throw new BadRequestException(`${app.name} is not available on this server`)
    }

    return provider
  }

  /**
   * Starts connecting an account: remembers who asked, for which form and app,
   * under a random `state`, and returns the provider's authorize URL.
   */
  async createAuthorization(
    app: AppDefinition,
    formId: string,
    userId: string
  ): Promise<{ url: string; state: string }> {
    const provider = this.requireProvider(app)
    const scopes = app.auth.type === 'oauth2' ? app.auth.scopes : []
    const state = base64Url(crypto.randomBytes(32))
    const codeVerifier = provider.pkce ? base64Url(crypto.randomBytes(32)) : undefined
    const data: IntegrationOAuthState = { appId: app.id, formId, userId, codeVerifier }

    await this.redisService.set({
      key: this.stateKey(state),
      value: JSON.stringify(data),
      duration: STATE_TTL
    })

    const url = new URL(provider.authorizeUrl)

    for (const [key, value] of Object.entries(provider.authorizeParams ?? {})) {
      url.searchParams.set(key, value)
    }

    url.searchParams.set('client_id', provider.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', state)

    if (codeVerifier) {
      url.searchParams.set(
        'code_challenge',
        base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
      )
      url.searchParams.set('code_challenge_method', 'S256')
    }

    return { url: url.toString(), state }
  }

  /**
   * Reads and deletes a pending authorization, so each `state` works once.
   * Rejects a state that was started by another user.
   */
  async consumeAuthorization(state: string, userId: string): Promise<IntegrationOAuthState> {
    const value = state ? await this.redisService.getdel(this.stateKey(state)) : null
    let data: IntegrationOAuthState | undefined

    try {
      data = value ? JSON.parse(value) : undefined
    } catch (_) {
      data = undefined
    }

    if (!data || !data.formId || !data.appId || data.userId !== userId) {
      throw new BadRequestException('Invalid OAuth state')
    }

    return data
  }

  /**
   * Exchanges the authorization code and stores the tokens for the form's
   * integration, creating a pending integration if there isn't one yet.
   */
  async completeAuthorization(
    app: AppDefinition,
    formId: string,
    code: string,
    codeVerifier?: string
  ): Promise<void> {
    const provider = this.requireProvider(app)
    const response = await this.requestToken(provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {})
    })

    const integration = await this.integrationService.findOne(formId, app.id)
    const previous = integration?.thirdPartyOauthId
      ? await this.thirdPartyService.findById(integration.thirdPartyOauthId)
      : null
    const tokens = this.toStoredTokens(response, previous ? this.readTokens(previous) : undefined)

    // An expiring token that can't be refreshed would look connected, then
    // stop working within the hour
    if (tokens.expiresAt && !tokens.refreshToken) {
      throw new OAuth2TokenError(`${provider.name} did not return a refresh token`)
    }

    const integrationId =
      integration?.id ??
      (await this.integrationService.create({
        formId,
        appId: app.id,
        config: {},
        status: IntegrationStatusEnum.PENDING
      }))
    const scope = app.auth.type === 'oauth2' ? app.auth.scopes.join(' ') : ''

    // One connection per integration, so deleting the integration or another
    // form's connection never affects this one
    const thirdPartyOauthId = await this.thirdPartyService.createOrUpdate(
      app.id,
      integrationId,
      scope,
      { tokens: this.encryptTokens(tokens) }
    )

    if (previous && previous.id !== thirdPartyOauthId) {
      await this.thirdPartyService.delete(previous.id)
    }

    const updates: Partial<IntegrationModel> = { thirdPartyOauthId }

    if (integration?.status === IntegrationStatusEnum.NEEDS_RECONNECT) {
      updates.status = this.hasConfig(integration)
        ? IntegrationStatusEnum.ACTIVE
        : IntegrationStatusEnum.PENDING
    }

    await this.integrationService.update(integrationId, updates)

    // Send what arrived while the account needed reconnecting
    if (integration && (updates.status ?? integration.status) === IntegrationStatusEnum.ACTIVE) {
      await this.integrationService.resendWaiting(integration)
    }
  }

  async disconnect(integration: IntegrationModel): Promise<void> {
    if (integration.thirdPartyOauthId) {
      await this.thirdPartyService.delete(integration.thirdPartyOauthId)
    }
  }

  // --- Credentials for run() --------------------------------------------------

  /**
   * The `auth` value handed to the app's run(). Throws IntegrationAuthError
   * when retrying can't help.
   */
  async getRunAuth(app: AppDefinition, integration: IntegrationModel): Promise<AppRunAuth> {
    switch (app.auth.type) {
      case 'apiKey':
        return { type: 'apiKey', apiKey: await this.readApiKey(integration) }

      case 'oauth2':
        return { type: 'oauth2', accessToken: await this.getAccessToken(app, integration) }

      default:
        return { type: 'none' }
    }
  }

  private async readApiKey(integration: IntegrationModel): Promise<string> {
    if (!integration.apiKey) {
      throw new IntegrationAuthError('No API key is saved for this integration')
    }

    try {
      return decryptSecret(integration.apiKey, FORM_ENCRYPTION_KEY)
    } catch (_) {
      // e.g. FORM_ENCRYPTION_KEY changed. Like unreadable OAuth2 tokens, the
      // form owner has to enter it again; submissions wait until then.
      return this.needsReconnect(
        integration,
        'The saved API key cannot be read',
        'Enter it again to resume deliveries.'
      )
    }
  }

  /**
   * Returns a valid access token, refreshing it first if it has expired.
   * If the provider rejects the refresh token, the integration is marked as
   * needing reconnection.
   */
  async getAccessToken(app: AppDefinition, integration: IntegrationModel): Promise<string> {
    const provider = this.appService.findOAuth2Provider(app)

    if (!provider) {
      throw new IntegrationAuthError(`${app.name} is not configured on this server`)
    }

    const record = integration.thirdPartyOauthId
      ? await this.thirdPartyService.findById(integration.thirdPartyOauthId)
      : null

    if (!record) {
      return this.needsReconnect(integration, `No ${provider.name} account is connected`)
    }

    const tokens = this.readTokens(record)

    if (!tokens) {
      return this.needsReconnect(integration, `The ${provider.name} tokens cannot be read`)
    }

    if (tokens.accessToken && !this.isExpired(tokens)) {
      return tokens.accessToken
    }

    if (!tokens.refreshToken) {
      return this.needsReconnect(integration, `The ${provider.name} access token has expired`)
    }

    let response: OAuth2TokenResponse

    try {
      response = await this.requestToken(provider, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken
      })
    } catch (err) {
      if (err instanceof OAuth2TokenError && err.code === 'invalid_grant') {
        // A concurrent job may have refreshed first and rotated the refresh
        // token we used; if so, its access token is good
        const latest = await this.thirdPartyService.findById(record.id)
        const latestTokens = latest ? this.readTokens(latest) : undefined

        if (
          latestTokens?.accessToken &&
          latestTokens.refreshToken !== tokens.refreshToken &&
          !this.isExpired(latestTokens)
        ) {
          return latestTokens.accessToken
        }

        return this.needsReconnect(integration, err.message)
      }

      if (err instanceof OAuth2TokenError && err.code === 'invalid_client') {
        throw new IntegrationAuthError(err.message)
      }

      // Network errors and provider outages: let the queue retry
      throw err
    }

    const refreshed = this.toStoredTokens(response, tokens)
    await this.thirdPartyService.update(record.id, { tokens: this.encryptTokens(refreshed) })

    return refreshed.accessToken!
  }

  private async needsReconnect(
    integration: IntegrationModel,
    reason: string,
    action = 'Reconnect the account to resume deliveries.'
  ): Promise<never> {
    await this.integrationService.update(integration.id, {
      status: IntegrationStatusEnum.NEEDS_RECONNECT
    })
    this.logger.warn(`Integration ${integration.id} needs reconnecting: ${reason}`)

    throw new IntegrationAuthError(`${reason}. ${action}`, true)
  }

  // --- Tokens -----------------------------------------------------------------

  private hasConfig(integration: IntegrationModel): boolean {
    return Object.keys(mapToObject(integration.config) ?? {}).length > 0
  }

  private isExpired(tokens: StoredTokens): boolean {
    return !!tokens.expiresAt && tokens.expiresAt - EXPIRY_MARGIN <= Date.now()
  }

  private toStoredTokens(response: OAuth2TokenResponse, previous?: StoredTokens): StoredTokens {
    const expiresIn = Number(response.expires_in)

    return {
      accessToken: response.access_token,
      // Providers that don't rotate refresh tokens omit them on refresh
      refreshToken: response.refresh_token || previous?.refreshToken,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
    }
  }

  private encryptTokens(tokens: StoredTokens): Record<string, any> {
    const stored: Record<string, any> = {}

    if (tokens.accessToken) {
      stored.accessToken = encryptSecret(tokens.accessToken, FORM_ENCRYPTION_KEY)
    }

    if (tokens.refreshToken) {
      stored.refreshToken = encryptSecret(tokens.refreshToken, FORM_ENCRYPTION_KEY)
    }

    if (tokens.expiresAt) {
      stored.expiresAt = tokens.expiresAt
    }

    return stored
  }

  // Undefined when the tokens can't be decrypted, e.g. after the key changed
  private readTokens(record: ThirdPartyOauthModel): StoredTokens | undefined {
    const stored = mapToObject(record.tokens) ?? {}

    try {
      return {
        accessToken: stored.accessToken
          ? decryptSecret(stored.accessToken, FORM_ENCRYPTION_KEY)
          : undefined,
        refreshToken: stored.refreshToken
          ? decryptSecret(stored.refreshToken, FORM_ENCRYPTION_KEY)
          : undefined,
        expiresAt: Number(stored.expiresAt) || undefined
      }
    } catch (_) {
      return undefined
    }
  }

  private async requestToken(
    provider: ConfiguredOAuth2Provider,
    params: Record<string, string>
  ): Promise<OAuth2TokenResponse> {
    let response: { statusCode: number; body: any }

    try {
      response = await got.post(provider.tokenUrl, {
        form: {
          ...params,
          client_id: provider.clientId,
          client_secret: provider.clientSecret
        },
        headers: { accept: 'application/json' },
        responseType: 'json',
        throwHttpErrors: false,
        followRedirect: false,
        retry: { limit: 0 },
        timeout: TOKEN_REQUEST_TIMEOUT
      })
    } catch (err: any) {
      // got's errors carry the request options, which include the client
      // secret and tokens, so only the error code is passed on
      throw new OAuth2TokenError(
        `${provider.name} token request failed: ${err?.code || 'network error'}`
      )
    }

    const body = response.body

    if (
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      typeof body?.access_token === 'string' &&
      body.access_token
    ) {
      return body
    }

    const code =
      typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined

    throw new OAuth2TokenError(
      `${provider.name} rejected the token request: ${code ?? `HTTP ${response.statusCode}`}`,
      code
    )
  }
}
