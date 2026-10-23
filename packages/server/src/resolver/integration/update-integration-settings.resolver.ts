import { BadRequestException } from '@nestjs/common'

import { validateAppConfig } from '../../apps/validate-config'
import { Auth, FormGuard } from '@decorator'
import { UpdateIntegrationInput } from '@graphql'
import { helper } from '@heyform-inc/utils'
import { IntegrationModel, IntegrationStatusEnum } from '@model'
import { Args, Mutation, Resolver } from '@nestjs/graphql'
import { AppService, IntegrationAuthService, IntegrationService } from '@service'

@Resolver()
@Auth()
export class UpdateIntegrationSettingsResolver {
  constructor(
    private readonly appService: AppService,
    private readonly integrationService: IntegrationService,
    private readonly integrationAuthService: IntegrationAuthService
  ) {}

  @Mutation(returns => Boolean)
  @FormGuard()
  async updateIntegrationSettings(
    @Args('input')
    input: UpdateIntegrationInput
  ): Promise<boolean> {
    const app = this.appService.findById(input.appId)

    if (!app) {
      throw new BadRequestException('The app does not exist')
    }

    if (!this.appService.isAvailable(app)) {
      throw new BadRequestException(`${app.name} is not available on this server`)
    }

    if (helper.isEmpty(input.config)) {
      throw new BadRequestException('Invalid attributes arguments')
    }

    const config = await validateAppConfig(app, input.config)
    const integration = await this.integrationService.findOne(input.formId, app.id)
    const updates: Partial<IntegrationModel> = {
      config,
      status: IntegrationStatusEnum.ACTIVE
    }

    if (app.auth.type === 'apiKey') {
      const apiKey = input.apiKey?.trim()

      if (apiKey) {
        Object.assign(updates, this.integrationAuthService.encryptApiKey(apiKey))
      } else if (!integration?.apiKey) {
        throw new BadRequestException(`${app.auth.label || 'API key'} is required`)
      }
    }

    if (app.auth.type === 'oauth2') {
      if (!integration?.thirdPartyOauthId) {
        const provider = this.appService.findOAuth2Provider(app)
        throw new BadRequestException(`Connect your ${provider?.name ?? app.name} account first`)
      }

      // Saving settings doesn't fix a revoked grant; only reconnecting does
      if (integration.status === IntegrationStatusEnum.NEEDS_RECONNECT) {
        updates.status = IntegrationStatusEnum.NEEDS_RECONNECT
      }
    }

    await this.integrationService.createOrUpdate(input.formId, app.id, updates)

    return true
  }
}
