import {
  ActionEnum,
  AnswerValue,
  FieldKindEnum,
  FormField,
  Logic,
  NavigateAction,
  Variable
} from '@heyform-inc/shared-types-enums'

import { helper } from '@heyform-inc/utils'

import { validateCondition } from './validate-condition'

export function getNavigateFieldId(
  field: FormField,
  thankYouFields: FormField[] = [],
  logics?: Logic[] | null,
  variables?: Variable[] | null,
  fieldValues: Record<string, any> = {},
  variableValues: Record<string, any> = {}
) {
  if (helper.isEmpty(thankYouFields)) {
    return
  }

  const logic = logics?.find(l => l.fieldId === field.id)

  if (logic) {
    const { payloads } = logic
    const result = payloads.filter(p => p.action.kind === ActionEnum.NAVIGATE)

    for (const payload of result) {
      const { condition, action } = payload
      const isValidated = validateCondition(field, condition, fieldValues)

      if (isValidated) {
        const { fieldId } = action as NavigateAction
        const index = thankYouFields.findIndex(f => f.id === fieldId)

        if (index > -1) {
          return fieldId
        }
      }
    }
  }

  // Check variables
  for (const variable of variables || []) {
    if (helper.isValidArray(variable.logics)) {
      for (const { condition, action } of variable.logics!) {
        const _field: any = {
          id: variable.id,
          kind: variable.kind === 'number' ? FieldKindEnum.NUMBER : FieldKindEnum.SHORT_TEXT
        }

        const isValidated = validateCondition(_field, condition, variableValues)

        if (isValidated) {
          const { fieldId } = action as NavigateAction
          const index = thankYouFields.findIndex(f => f.id === fieldId)

          if (index > -1) {
            return fieldId
          }
        }
      }
    }
  }

  if (field.nextFieldId && thankYouFields.some(f => f.id === field.nextFieldId)) {
    return field.nextFieldId
  }
}

// The ending a respondent reaches from the last field on their route. The renderer
// shows it and the server decides from it whether to save, so they must agree.
export function resolveEnding(
  lastField: FormField | undefined,
  thankYouFields: FormField[] = [],
  logics?: Logic[] | null,
  variables?: Variable[] | null,
  fieldValues: Record<string, any> = {},
  variableValues: Record<string, AnswerValue> = {}
): FormField | undefined {
  const fieldId =
    lastField &&
    getNavigateFieldId(lastField, thankYouFields, logics, variables, fieldValues, variableValues)

  return thankYouFields.find(f => f.id === fieldId) ?? thankYouFields[0]
}
