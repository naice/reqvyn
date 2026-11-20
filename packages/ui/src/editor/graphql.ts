import { StreamLanguage, type StreamParser } from '@codemirror/language';

const KEYWORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
  'on',
  'type',
  'interface',
  'union',
  'enum',
  'input',
  'scalar',
  'schema',
  'extend',
  'implements',
  'directive',
  'repeatable',
]);
const ATOMS = new Set(['true', 'false', 'null']);

interface GqlState {
  blockString: boolean;
}

/** Small GraphQL tokenizer (no external grammar dependency). */
export const graphqlParser: StreamParser<GqlState> = {
  name: 'graphql',
  startState: () => ({ blockString: false }),
  token(stream, state) {
    if (state.blockString) {
      while (!stream.eol()) {
        if (stream.match('"""')) {
          state.blockString = false;
          return 'string';
        }
        stream.next();
      }
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('"""')) {
      state.blockString = true;
      return 'string';
    }
    const ch = stream.peek() ?? '';
    if (ch === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '"') {
      stream.next();
      while (!stream.eol()) {
        const c = stream.next();
        if (c === '\\') stream.next();
        else if (c === '"') break;
      }
      return 'string';
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
    if (ch === '$') {
      stream.next();
      stream.match(/^[_A-Za-z][_0-9A-Za-z]*/);
      return 'variableName.special';
    }
    if (ch === '@') {
      stream.next();
      stream.match(/^[_A-Za-z][_0-9A-Za-z]*/);
      return 'meta';
    }
    if (stream.match(/^[_A-Za-z][_0-9A-Za-z]*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return 'keyword';
      if (ATOMS.has(w)) return 'atom';
      if (/^[A-Z]/.test(w)) return 'typeName';
      return 'propertyName';
    }
    if (stream.match('...')) return 'punctuation';
    stream.next();
    return /[{}()[\]]/.test(ch) ? 'bracket' : 'punctuation';
  },
  languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['(', '[', '{', '"'] } },
};

export const graphqlLanguage = StreamLanguage.define(graphqlParser);
