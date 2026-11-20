import { AuthSchema, type Auth } from '@reqvyn/core';
export { createCollection, createRequest, requestsInOrder, type Collection } from '@reqvyn/core';

export function createAuth(data: Record<string, unknown>): Auth {
  return AuthSchema.parse(data);
}
