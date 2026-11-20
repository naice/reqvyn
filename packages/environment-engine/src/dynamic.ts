import { newId } from '@reqvyn/shared';

const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Robin', 'Kai', 'Noa', 'Luca', 'Mika', 'Ari', 'Jules'];
const LAST = ['Meyer', 'Smith', 'Garcia', 'Nguyen', 'Kowalski', 'Rossi', 'Silva', 'Kim', 'Novak', 'Larsen'];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[randInt(0, chars.length - 1)];
  return s;
}

/** Evaluate a dynamic variable such as `$uuid` or `$randomInt:1:10`. Returns undefined if unknown. */
export function evaluateDynamic(expr: string): string | undefined {
  const [name, ...args] = expr.split(':');
  switch (name) {
    case '$uuid':
    case '$guid':
    case '$randomUUID':
      return newId();
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$timestampMs':
      return String(Date.now());
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$date':
      return new Date().toISOString().slice(0, 10);
    case '$randomInt': {
      const min = args[0] !== undefined ? Number(args[0]) : 0;
      const max = args[1] !== undefined ? Number(args[1]) : 1000;
      if (Number.isNaN(min) || Number.isNaN(max) || max < min) return undefined;
      return String(randInt(min, max));
    }
    case '$randomFloat':
      return String(Math.random());
    case '$randomBoolean':
      return String(Math.random() < 0.5);
    case '$randomString': {
      const len = args[0] !== undefined ? Math.min(1024, Math.max(1, Number(args[0]) || 16)) : 16;
      return randString(len);
    }
    case '$randomEmail':
      return `${randString(8).toLowerCase()}@example.com`;
    case '$randomFirstName':
      return FIRST[randInt(0, FIRST.length - 1)];
    case '$randomLastName':
      return LAST[randInt(0, LAST.length - 1)];
    default:
      return undefined;
  }
}
