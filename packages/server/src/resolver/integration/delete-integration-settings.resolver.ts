import { Auth, FormGuard } from '@decorator'
import { IntegrationInput } from '@graphql'
import { Args, Mutation, Resolver } from '@nestjs/graphql'
import { IntegrationAuthService, IntegrationService } from '@service'

@Resolver()
@Auth()
export class DeleteIntegrationSettingsResolver {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly integrationAuthService: IntegrationAuthService
  ) {}

  @Mutation(returns => Boolean)
  @FormGuard()
  async deleteIntegrationSettings(
    @Args('input')
    input: IntegrationInput
  ): Promise<boolean> {
    const integration = await this.integrationService.findOne(input.formId, input.appId)

    // Drop the connected account's tokens with the integration
    if (integration) {
      await this.integrationAuthService.disconnect(integration)
    }

    return this.integrationService.delete(input.formId, input.appId)
  }
}
