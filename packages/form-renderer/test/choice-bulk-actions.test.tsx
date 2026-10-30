// @vitest-environment jsdom
import { FieldKindEnum } from '@heyform-inc/shared-types-enums'
import { act, useState } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { FormRenderer } from '../src/Renderer'
import { ChoiceRadioGroup } from '../src/components'
import { initI18n } from '../src/i18n'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  initI18n()
  ;(window as any).heyform = { device: {} }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await act(async () => root.unmount())
  container.remove()
})

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    keyName: String.fromCharCode(65 + index),
    label: `Option ${index + 1}`,
    value: `c${index}`
  }))
}

const allValues = makeOptions(6).map(option => option.value)

// Keeps the value like the form field does, so each change sees the previous one.
async function mount(props: Record<string, any> = {}, optionCount = 6, initialValue?: any) {
  const onChange = vi.fn()

  function Group() {
    const [value, setValue] = useState<any>(initialValue)

    return (
      <ChoiceRadioGroup
        options={makeOptions(optionCount)}
        allowMultiple={true}
        value={value}
        onChange={next => {
          onChange(next)
          setValue(next)
        }}
        {...props}
      />
    )
  }

  await act(async () => root.render(<Group />))
  return onChange
}

function action(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    button => button.textContent === label
  )
}

function count() {
  return container.querySelector('.heyform-choice-count')?.textContent
}

async function click(element: HTMLElement) {
  await act(async () => element.click())
}

test('the actions appear only above five options', async () => {
  await mount({}, 5)
  expect(action('Select all')).toBeUndefined()
  expect(action('Unselect all')).toBeUndefined()
  expect(count()).toBeUndefined()

  await mount({}, 6)
  expect(action('Select all')).toBeDefined()
  expect(action('Unselect all')).toBeDefined()
  expect(count()).toBe('0 of 6')
})

test('single-select questions have no actions, nor do multi-selects limited to one', async () => {
  await mount({ allowMultiple: false })
  expect(action('Unselect all')).toBeUndefined()

  await mount({ max: 1 })
  expect(action('Unselect all')).toBeUndefined()
})

test('the actions never submit the form they sit in', async () => {
  await mount()

  expect(action('Select all')!.type).toBe('button')
  expect(action('Unselect all')!.type).toBe('button')
})

test('select all then unselect all, with each disabled when it would do nothing', async () => {
  const onChange = await mount()

  expect(action('Unselect all')!.disabled).toBe(true)

  await click(action('Select all')!)
  expect(onChange).toHaveBeenLastCalledWith({ value: allValues, other: undefined })
  expect(container.querySelectorAll('.heyform-radio-selected')).toHaveLength(6)
  expect(count()).toBe('6 of 6')
  expect(action('Select all')!.disabled).toBe(true)

  await click(action('Unselect all')!)
  expect(onChange).toHaveBeenLastCalledWith({ value: [], other: undefined })
  expect(container.querySelectorAll('.heyform-radio-selected')).toHaveLength(0)
  expect(count()).toBe('0 of 6')
})

test('"Other" keeps its text on select all and clears on unselect all', async () => {
  const onChange = await mount({ allowOther: true, isOtherFilled: true }, 6, {
    value: [],
    other: 'Editor'
  })

  expect(count()).toBe('1 of 7')

  await click(action('Select all')!)
  expect(onChange).toHaveBeenLastCalledWith({ value: allValues, other: 'Editor' })
  expect(container.querySelector('.heyform-radio-other input')).not.toBeNull()

  await click(action('Unselect all')!)
  expect(onChange).toHaveBeenLastCalledWith({ value: [], other: undefined })
  expect(container.querySelector('.heyform-radio-other input')).toBeNull()
})

test('a limit removes select all and counts towards the limit', async () => {
  const onChange = await mount({ max: 3 }, 6, { value: ['c0', 'c1'] })

  expect(action('Select all')).toBeUndefined()
  expect(count()).toBe('2 of 3')

  await click(action('Unselect all')!)
  expect(onChange).toHaveBeenLastCalledWith({ value: [], other: undefined })
})

test('a question still focuses Next, and Enter on an action does not move on', async () => {
  vi.useFakeTimers()
  // jsdom has no layout, and the form only focuses elements it can see.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)

  const form: any = {
    id: 'bulk-actions',
    fields: [
      {
        id: 'choices',
        kind: FieldKindEnum.MULTIPLE_CHOICE,
        title: 'Choices',
        properties: {
          allowMultiple: true,
          choices: makeOptions(6).map(({ label, value }) => ({ id: value, label }))
        }
      },
      { id: 'last', kind: FieldKindEnum.SHORT_TEXT, title: 'Last' }
    ],
    settings: {},
    themeSettings: {}
  }

  await act(async () => root.render(<FormRenderer form={form} locale="en" autoSave={false} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100)
  })

  expect(document.activeElement?.className).toContain('heyform-submit-button')

  const selectAll = action('Select all')!
  selectAll.focus()
  await act(async () => {
    selectAll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.advanceTimersByTimeAsync(1100)
  })

  expect(container.querySelector('.heyform-body-active .heyform-block-title')?.textContent).toBe(
    'Choices'
  )
})
