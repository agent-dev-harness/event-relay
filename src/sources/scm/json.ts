// Readers for host payloads, which are untyped JSON.

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const str = (obj: Json, key: string): string | null => (typeof obj[key] === 'string' ? obj[key] : null);
export const num = (obj: Json, key: string): number | null => (typeof obj[key] === 'number' ? obj[key] : null);
