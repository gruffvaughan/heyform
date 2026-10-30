import { ChoiceBadgeEnum } from '@heyform-inc/shared-types-enums'
import clsx from 'clsx'
import { FC, useCallback, useEffect, useMemo, useState } from 'react'

import { getChoiceKeyName, useTranslation } from '../utils'
import { helper } from '@heyform-inc/utils'

import { IComponentProps } from '../typings'
import type { ChoiceRadioOption } from './ChoiceRadio'
import { ChoiceRadio } from './ChoiceRadio'

interface ChoiceRadioGroupProps extends Omit<IComponentProps, 'onChange'> {
  options: ChoiceRadioOption[]
  allowMultiple?: boolean
  allowOther?: boolean
  // "Other" can be chosen without typing; it's then answered as an empty string.
  allowBlankOther?: boolean
  badge?: ChoiceBadgeEnum
  verticalAlignment?: boolean
  isOtherFilled?: boolean
  isHotkeyShow?: boolean
  max?: number
  enableImage?: boolean
  value?: any
  onChange?: (value: any) => void
}

// Bulk actions appear on multi-select questions with more options than this.
const BULK_ACTIONS_THRESHOLD = 5

function resetArray(arr: any) {
  return (helper.isArray(arr) ? arr : [arr]).filter(helper.isValid)
}

export const ChoiceRadioGroup: FC<ChoiceRadioGroupProps> = ({
  className,
  options,
  allowMultiple = false,
  allowOther = false,
  allowBlankOther = false,
  badge = ChoiceBadgeEnum.LETTER,
  verticalAlignment = true,
  isOtherFilled = false,
  isHotkeyShow = true,
  max = 0,
  enableImage,
  value: rawValue,
  onChange,
  ...restProps
}) => {
  const { t } = useTranslation()

  const values = useMemo(() => resetArray(rawValue?.value || []), [rawValue])
  const otherValue = useMemo(() => rawValue?.other, [rawValue])

  const selectedCount = values.length + (allowOther && isOtherFilled ? 1 : 0)
  const isDisabled = max > 0 && selectedCount >= max
  const [isOtherSelected, setIsOtherSelected] = useState(false)

  const isBulkActionsShow = allowMultiple && max !== 1 && options.length > BULK_ACTIONS_THRESHOLD
  const choiceCount = options.length + (allowOther ? 1 : 0)
  const isAllSelected = options.every(option => values.includes(option.value))

  const handleClick = useCallback(
    (value: any) => {
      let newValues: any[]

      if (!allowMultiple) {
        newValues = [value]
        setIsOtherSelected(false)

        // Choosing an option replaces "Other" on a single-select question.
        onChange?.({ value: newValues })
        return
      } else {
        if (values.includes(value)) {
          newValues = values.filter((v: any) => v !== value)
        } else {
          newValues = isDisabled ? values : [...values, value]
        }
      }

      onChange?.({
        value: newValues,
        other: otherValue
      })
    },
    [allowMultiple, isDisabled, onChange, otherValue, values]
  )

  const handleSelectAll = useCallback(() => {
    onChange?.({
      value: options.map(option => option.value),
      other: otherValue
    })
  }, [onChange, options, otherValue])

  const handleUnselectAll = useCallback(() => {
    setIsOtherSelected(false)
    onChange?.({ value: [], other: undefined })
  }, [onChange])

  const handleOtherChange = useCallback(
    (newOtherValue: string) => {
      let other: string | undefined = newOtherValue

      if (helper.isEmpty(other)) {
        if (allowBlankOther) {
          // Clearing the text keeps "Other" chosen.
          other = ''
        } else {
          other = undefined
          setIsOtherSelected(false)
        }
      }

      onChange?.({
        value: values,
        other
      })
    },
    [allowBlankOther, onChange, values]
  )

  const handleOtherBlur = useCallback(() => {
    if (!allowBlankOther && helper.isEmpty(otherValue)) {
      setIsOtherSelected(false)
    }
  }, [allowBlankOther, otherValue])

  const handleOtherClick = useCallback(() => {
    if (allowBlankOther) {
      if (isOtherSelected) {
        // A checked, empty "Other" on a multi-select question toggles off like an option.
        if (allowMultiple && helper.isEmpty(otherValue)) {
          setIsOtherSelected(false)
          onChange?.({ value: values, other: undefined })
        }

        return
      }

      if (isDisabled) {
        return
      }

      setIsOtherSelected(true)
      onChange?.({
        value: allowMultiple ? values : [],
        other: otherValue ?? ''
      })

      return
    }

    if (isDisabled) {
      return
    }

    setIsOtherSelected(true)

    if (!isOtherSelected && !allowMultiple) {
      onChange?.({
        value: [],
        other: otherValue
      })
    }
  }, [allowBlankOther, isDisabled, isOtherSelected, allowMultiple, onChange, otherValue, values])

  useEffect(() => {
    if (allowOther) {
      setIsOtherSelected(helper.isValid(otherValue) || (allowBlankOther && otherValue === ''))
    }
  }, [])

  return (
    <div
      className={clsx(
        'heyform-radio-group',
        {
          'heyform-radio-group-disabled': isDisabled,
          'heyform-radio-group-horizontal': helper.isFalse(verticalAlignment)
        },
        className
      )}
      {...restProps}
    >
      {isBulkActionsShow && (
        <div className="heyform-choice-actions">
          <span className="heyform-choice-count">
            {t('{{selected}} of {{total}}', {
              selected: selectedCount,
              total: max > 0 ? Math.min(max, choiceCount) : choiceCount
            })}
          </span>

          <span className="heyform-choice-action-list">
            {/* A limit couldn't be honoured by selecting everything. */}
            {max < 1 && (
              <>
                <button
                  type="button"
                  className="heyform-choice-action"
                  disabled={isAllSelected}
                  onClick={handleSelectAll}
                >
                  {t('Select all')}
                </button>
                <span aria-hidden="true">·</span>
              </>
            )}
            <button
              type="button"
              className="heyform-choice-action"
              disabled={selectedCount < 1 && !isOtherSelected}
              onClick={handleUnselectAll}
            >
              {t('Unselect all')}
            </button>
          </span>
        </div>
      )}

      {options.map(option => (
        <ChoiceRadio
          key={option.value as string}
          {...option}
          enableImage={enableImage}
          isHotkeyShow={isHotkeyShow}
          isChecked={values.includes(option.value)}
          onClick={handleClick}
        />
      ))}

      {allowOther && (
        <ChoiceRadio
          className="heyform-radio-other"
          keyName={getChoiceKeyName(badge, options.length)}
          enableImage={enableImage}
          label={t('Other')}
          value={otherValue}
          isHotkeyShow={isHotkeyShow}
          isChecked={isOtherSelected}
          isOther={true}
          onBlur={handleOtherBlur}
          onClick={handleOtherClick}
          onChange={handleOtherChange}
        />
      )}
    </div>
  )
}
