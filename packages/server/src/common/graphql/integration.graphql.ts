import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator'

import { FormDetailInput } from './form.graphql'
import { IntegrationStatusEnum } from '@model'
import { Field, InputType, ObjectType } from '@nestjs/graphql'
import { GraphQLJSONObject } from 'graphql-type-json'

@InputType()
export class IntegrationInput extends FormDetailInput {
  @Field()
  appId: string
}

@InputType()
export class IntegrationOAuthInput extends IntegrationInput {
  @Field()
  code: string
}

@InputType()
export class UpdateIntegrationInput extends IntegrationInput {
  @Field(type => GraphQLJSONObject)
  config: Record<string, any>

  // For apps with `auth.type === 'apiKey'`. Omit to keep the saved key.
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apiKey?: string
}

@InputType()
export class UpdateIntegrationStatusInput extends IntegrationInput {
  @Field(type => Number)
  @IsEnum(IntegrationStatusEnum)
  status: IntegrationStatusEnum
}

@ObjectType()
export class IntegrationRecordType {
  @Field()
  id: string

  @Field()
  submissionId: string

  // IntegrationRecordStatusEnum: 1 succeeded, 2 failed
  @Field(type => Number)
  status: number

  @Field()
  attempt: number

  @Field()
  maxAttempts: number

  @Field()
  willRetry: boolean

  @Field({ nullable: true })
  error?: string

  // Unix seconds
  @Field()
  createdAt: number
}
