// @vitest-environment jsdom
import { FieldKindEnum, type FormField } from '@heyform-inc/shared-types-enums'
import { act } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { FormRenderer } from '../src/Renderer'
import { initI18n } from '../src/i18n'

let container: HTMLDivElement
let root: Root
const scrollIntoView = vi.fn()

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  initI18n()
  ;(window as any).heyform = { device: { android: true, mobile: true } }
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function mount(field: FormField) {
  const form: any = {
    id: 'resize-test',
    fields: [field, { id: 'last', kind: FieldKindEnum.SHORT_TEXT, title: 'Last' }],
    settings: {},
    themeSettings: {}
  }

  await act(async () => root.render(<FormRenderer form={form} locale="en" autoSave={false} />))
}

async function resizeWithFocusOn(selector: string) {
  container.querySelector<HTMLElement>(selector)!.focus()

  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })
}

// The URL bar showing or hiding also resizes the window, and this button sits below a long list.
test('resizing leaves the scroll position alone when a button has focus', async () => {
  await mount({
    id: 'choices',
    kind: FieldKindEnum.MULTIPLE_CHOICE,
    title: 'Choices',
    properties: { allowMultiple: true, choices: [{ id: 'a', label: 'A' }] }
  } as FormField)

  await resizeWithFocusOn('.heyform-submit-button')

  expect(scrollIntoView).not.toHaveBeenCalled()
})

test('resizing keeps a focused text input in view above the keyboard', async () => {
  await mount({ id: 'text', kind: FieldKindEnum.SHORT_TEXT, title: 'Text' })

  await resizeWithFocusOn('input')

  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})
