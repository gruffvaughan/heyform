import { Injectable } from '@nestjs/common'

import * as apps from '../apps'
import {
  ConfiguredOAuth2Provider,
  OAuth2Provider,
  oauth2Providers,
  readOAuth2Credentials
} from '../apps/oauth2-providers'
import { AppDefinition } from '../apps/types'

@Injectable()
export class AppService {
  private readonly apps: Record<string, AppDefinition> = apps
  providers: Record<string, OAuth2Provider> = oauth2Providers

  findAll(): AppDefinition[] {
    return Object.values(this.apps)
  }

  // Apps the form owner can set up on this install
  findAllAvailable(): AppDefinition[] {
    return this.findAll().filter(app => this.isAvailable(app))
  }

  findById(id: string): AppDefinition | undefined {
    // Own properties only, so ids like `constructor` don't resolve to Object members
    return Object.prototype.hasOwnProperty.call(this.apps, id) ? this.apps[id] : undefined
  }

  // An oauth2 app is only usable once its provider's client credentials are set
  isAvailable(app: AppDefinition): boolean {
    return app.auth.type !== 'oauth2' || !!this.findOAuth2Provider(app)
  }

  findOAuth2Provider(app: AppDefinition): ConfiguredOAuth2Provider | undefined {
    if (app.auth.type !== 'oauth2') {
      return
    }

    const providerId = app.auth.provider
    const provider = Object.prototype.hasOwnProperty.call(this.providers, providerId)
      ? this.providers[providerId]
      : undefined
    const credentials = provider && readOAuth2Credentials(provider.id)

    if (provider && credentials) {
      return { ...provider, ...credentials }
    }
  }
}
