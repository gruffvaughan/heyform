import {
  ActionEnum,
  ComparisonEnum,
  FieldKindEnum,
  FormField,
  Logic,
  Variable
} from '@heyform-inc/shared-types-enums'
import { expect, test } from 'vitest'

import { resolveEnding } from '../src'

const question: FormField = { id: 'q1', kind: FieldKindEnum.SHORT_TEXT }
const first: FormField = { id: 'first', kind: FieldKindEnum.THANK_YOU }
const second: FormField = { id: 'second', kind: FieldKindEnum.THANK_YOU }
const endings = [first, second]

const logics: Logic[] = [
  {
    fieldId: 'q1',
    payloads: [
      {
        id: 'p1',
        condition: { comparison: ComparisonEnum.IS, expected: 'no' },
        action: { kind: ActionEnum.NAVIGATE, fieldId: 'second' }
      }
    ]
  }
]

test('a logic jump picks its ending', () => {
  expect(resolveEnding(question, endings, logics, [], { q1: 'no' })).toBe(second)
})

test('a route with no jump falls through to the first ending', () => {
  expect(resolveEnding(question, endings, logics, [], { q1: 'yes' })).toBe(first)
})

test('a route with no fields falls through to the first ending', () => {
  expect(resolveEnding(undefined, endings)).toBe(first)
})

test('a next field picks its ending', () => {
  expect(resolveEnding({ ...question, nextFieldId: 'second' }, endings)).toBe(second)
})

test('a variable rule picks its ending', () => {
  const variables = [
    {
      id: 'score',
      kind: 'number',
      logics: [
        {
          condition: { comparison: ComparisonEnum.GREATER_THAN, expected: 5 },
          action: { kind: ActionEnum.NAVIGATE, fieldId: 'second' }
        }
      ]
    }
  ] as unknown as Variable[]

  expect(resolveEnding(question, endings, [], variables, {}, { score: 6 })).toBe(second)
  expect(resolveEnding(question, endings, [], variables, {}, { score: 1 })).toBe(first)
})

test('forms stored without logic or variables still resolve', () => {
  expect(resolveEnding(question, endings, null, null, { q1: 'no' })).toBe(first)
})

test('a form without endings has no ending', () => {
  expect(resolveEnding(question, [], logics, [], { q1: 'no' })).toBeUndefined()
})
