import { TFunction } from 'i18next'

import { INTEGRATION_STATUS_ENUM } from '@/consts'
import { AppSettingType, IntegratedAppType } from '@/types'

export function getIntegrationDescription(t: TFunction, app: IntegratedAppType) {
  return t(`form.integrations.apps.${app.id}.description`, {
    defaultValue: app.description
  })
}

export function getIntegrationSetting(
  t: TFunction,
  app: IntegratedAppType,
  setting: AppSettingType
) {
  return {
    ...setting,
    label: t(`form.integrations.apps.${app.id}.settings.${setting.name}.label`, {
      defaultValue: setting.label
    }),
    description: setting.description
      ? t(`form.integrations.apps.${app.id}.settings.${setting.name}.description`, {
          defaultValue: setting.description
        })
      : undefined,
    options: setting.options?.map(option => ({
      ...option,
      label: t(
        `form.integrations.apps.${app.id}.settings.${setting.name}.options.${option.value}`,
        {
          defaultValue: option.label
        }
      )
    }))
  }
}

export function getIntegrationDefaultConfig(app: IntegratedAppType) {
  return Object.fromEntries(
    (app.settings || [])
      .filter(setting => setting.defaultValue !== undefined && setting.defaultValue !== null)
      .map(setting => [setting.name, setting.defaultValue])
  )
}

// The server redirects to the provider and back to the integrations page
export function getIntegrationAuthorizeUrl(formId: string, appId: string) {
  return `/api/integrations/oauth/authorize?${new URLSearchParams({ formId, appId })}`
}

// An OAuth2 app shows the connect step instead of its settings until an
// account is connected, and again once the connection stops working
export function needsAccountConnection(app: IntegratedAppType) {
  return (
    app.auth?.type === 'oauth2' &&
    (!app.integration?.connected ||
      app.integration?.status === INTEGRATION_STATUS_ENUM.NEEDS_RECONNECT)
  )
}

export function getIntegrationAuth(t: TFunction, app: IntegratedAppType) {
  const auth = app.auth

  return {
    providerName: auth?.providerName || app.name,
    label: t(`form.integrations.apps.${app.id}.auth.label`, {
      defaultValue: auth?.label || t('form.integrations.auth.apiKey')
    }),
    description: auth?.description
      ? t(`form.integrations.apps.${app.id}.auth.description`, {
          defaultValue: auth.description
        })
      : undefined
  }
}
