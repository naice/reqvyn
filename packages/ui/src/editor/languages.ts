import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { yaml } from '@codemirror/lang-yaml';
import type { LanguageId } from '../lib/language';
import { graphqlLanguage } from './graphql';

const cache = new Map<LanguageId, Extension>();

export function languageExtension(id: LanguageId): Extension {
  let ext = cache.get(id);
  if (!ext) {
    switch (id) {
      case 'json':
        ext = json();
        break;
      case 'xml':
        ext = xml();
        break;
      case 'html':
        ext = html();
        break;
      case 'javascript':
        ext = javascript();
        break;
      case 'yaml':
        ext = yaml();
        break;
      case 'graphql':
        ext = graphqlLanguage;
        break;
      default:
        ext = [];
    }
    cache.set(id, ext);
  }
  return ext;
}
