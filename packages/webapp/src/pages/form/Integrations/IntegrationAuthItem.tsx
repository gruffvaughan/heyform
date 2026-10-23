import { useTranslation } from 'react-i18next'

import { getIntegrationAuth, getIntegrationAuthorizeUrl } from './utils'

import { Button, Form, Input } from '@/components'
import { INTEGRATION_STATUS_ENUM } from '@/consts'
import { IntegratedAppType } from '@/types'

// The key input for `apiKey` apps. The saved key is never sent back, so
// leaving the input blank keeps it.
export function ApiKeyItem({ app }: { app: IntegratedAppType }) {
  const { t } = useTranslation()
  const { label, description } = getIntegrationAuth(t, app)
  const hint = app.integration?.apiKeyHint

  return (
    <Form.Item
      name="apiKey"
      label={label}
      footer={
        description || hint ? (
          <>
            {description && <div>{description}</div>}
            {hint && <div>{t('form.integrations.auth.apiKeySaved', { hint })}</div>}
          </>
        ) : undefined
      }
      rules={[
        {
          required: !hint,
          whitespace: true
        }
      ]}
    >
      <Input type="password" autoComplete="off" placeholder={hint} />
    </Form.Item>
  )
}

// Connect step for `oauth2` apps, before the settings
export function ConnectAccount({ app, formId }: { app: IntegratedAppType; formId: string }) {
  const { t } = useTranslation()
  const { providerName } = getIntegrationAuth(t, app)
  const isReconnect = app.integration?.status === INTEGRATION_STATUS_ENUM.NEEDS_RECONNECT

  function handleClick() {
    window.location.assign(getIntegrationAuthorizeUrl(formId, app.id))
  }

  return (
    <div className="space-y-4">
      <p className="text-secondary text-center text-sm">
        {isReconnect
          ? t('form.integrations.auth.needsReconnect', { name: providerName })
          : t('form.integrations.auth.connectDescription', { name: providerName })}
      </p>
      <Button className="w-full" onClick={handleClick}>
        {t(
          isReconnect
            ? 'form.integrations.auth.reconnectAccount'
            : 'form.integrations.auth.connectAccount',
          { name: providerName }
        )}
      </Button>
    </div>
  )
}
