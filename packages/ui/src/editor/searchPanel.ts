import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';

/** Matches are counted up to this limit; beyond it the counter shows "9999+". */
const MAX_COUNT = 9999;

interface Matches {
  from: number[];
  to: number[];
  capped: boolean;
}

function collectMatches(state: EditorState, query: SearchQuery): Matches | null {
  if (!query.search || !query.valid) return null;
  const m: Matches = { from: [], to: [], capped: false };
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (m.from.length >= MAX_COUNT) {
      m.capped = true;
      break;
    }
    m.from.push(r.value.from);
    m.to.push(r.value.to);
  }
  return m;
}

/** 1-based index of the match the main selection sits on, or 0. */
function currentIndex(m: Matches, state: EditorState): number {
  const { from, to } = state.selection.main;
  let lo = 0;
  let hi = m.from.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m.from[mid]! < from) lo = mid + 1;
    else if (m.from[mid]! > from) hi = mid - 1;
    else return m.to[mid] === to ? mid + 1 : 0;
  }
  return 0;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function iconButton(icon: string, label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const b = el('button', `rv-iconbtn ${extraClass}`, { type: 'button', title: label, 'aria-label': label });
  b.append(el('span', `codicon codicon-${icon}`, { 'aria-hidden': 'true' }));
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  b.addEventListener('click', onClick);
  return b;
}

/** A find/replace panel styled after VS Code's find widget, with a match counter. */
export function createSearchPanel(view: EditorView): Panel {
  const readOnly = view.state.readOnly;
  let query = getSearchQuery(view.state);
  let matches = collectMatches(view.state, query);
  let replaceOpen = false;

  const dom = el('div', 'rv-find', { role: 'search' });
  const toggleReplace = iconButton(
    'chevron-right',
    'Toggle Replace',
    () => setReplaceOpen(!replaceOpen),
    'rv-find__expand',
  );
  const rows = el('div', 'rv-find__rows');

  // Find row
  const findRow = el('div', 'rv-find__row');
  const findBox = el('div', 'rv-find__box');
  const searchField = el('input', 'rv-find__input', {
    type: 'text',
    placeholder: 'Find',
    'aria-label': 'Find',
    'main-field': 'true',
    spellcheck: 'false',
  });
  searchField.value = query.search;
  const optCase = iconButton(
    'case-sensitive',
    'Match Case (Alt+C)',
    () => toggle('caseSensitive'),
    'rv-find__opt',
  );
  const optWord = iconButton(
    'whole-word',
    'Match Whole Word (Alt+W)',
    () => toggle('wholeWord'),
    'rv-find__opt',
  );
  const optRegex = iconButton(
    'regex',
    'Use Regular Expression (Alt+R)',
    () => toggle('regexp'),
    'rv-find__opt',
  );
  findBox.append(searchField, optCase, optWord, optRegex);
  const count = el('span', 'rv-find__count', { 'aria-live': 'polite' });
  const prevBtn = iconButton('arrow-up', 'Previous Match (Shift+Enter)', () => findPrevious(view));
  const nextBtn = iconButton('arrow-down', 'Next Match (Enter)', () => findNext(view));
  const allBtn = iconButton('list-selection', 'Select All Matches (Alt+Enter)', () => selectMatches(view));
  const closeBtn = iconButton('close', 'Close (Escape)', () => closeSearchPanel(view));
  findRow.append(findBox, count, prevBtn, nextBtn, allBtn, closeBtn);
  rows.append(findRow);

  // Replace row (editable editors only)
  const replaceRow = el('div', 'rv-find__row rv-find__row--replace');
  const replaceField = el('input', 'rv-find__input', {
    type: 'text',
    placeholder: 'Replace',
    'aria-label': 'Replace',
    spellcheck: 'false',
  });
  replaceField.value = query.replace;
  const replaceBox = el('div', 'rv-find__box');
  replaceBox.append(replaceField);
  const replaceBtn = iconButton('replace', 'Replace (Enter)', () => replaceNext(view));
  const replaceAllBtn = iconButton('replace-all', 'Replace All (Ctrl+Alt+Enter)', () => replaceAll(view));
  replaceRow.append(replaceBox, replaceBtn, replaceAllBtn);
  if (!readOnly) {
    rows.append(replaceRow);
    dom.append(toggleReplace);
  } else {
    dom.classList.add('is-readonly');
  }
  dom.append(rows);

  function setReplaceOpen(open: boolean) {
    replaceOpen = open;
    replaceRow.hidden = !open;
    toggleReplace.firstElementChild!.className = `codicon codicon-chevron-${open ? 'down' : 'right'}`;
    toggleReplace.setAttribute('aria-expanded', String(open));
  }
  setReplaceOpen(false);

  function commit(next: Partial<ConstructorParameters<typeof SearchQuery>[0]>, jump: boolean) {
    const q = new SearchQuery({
      search: query.search,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      replace: query.replace,
      literal: query.literal,
      ...next,
    });
    if (q.eq(query)) return;
    view.dispatch({ effects: setSearchQuery.of(q) });
    if (jump) revealFirstFromCursor();
  }

  /** Like VS Code: while typing, select the first match at or after the cursor. */
  function revealFirstFromCursor() {
    if (!matches || matches.from.length === 0) return;
    const pos = view.state.selection.main.from;
    let i = matches.from.findIndex((f) => f >= pos);
    if (i < 0) i = 0;
    const range = EditorSelection.range(matches.from[i]!, matches.to[i]!);
    view.dispatch({
      selection: range,
      effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
      userEvent: 'select.search',
    });
  }

  function toggle(key: 'caseSensitive' | 'wholeWord' | 'regexp') {
    commit({ [key]: !query[key] }, false);
  }

  function render() {
    optCase.classList.toggle('is-active', query.caseSensitive);
    optWord.classList.toggle('is-active', query.wholeWord);
    optRegex.classList.toggle('is-active', query.regexp);
    optCase.setAttribute('aria-pressed', String(query.caseSensitive));
    optWord.setAttribute('aria-pressed', String(query.wholeWord));
    optRegex.setAttribute('aria-pressed', String(query.regexp));

    const invalid = !!query.search && !query.valid;
    const total = matches?.from.length ?? 0;
    const none = !!query.search && !invalid && total === 0;
    findBox.classList.toggle('is-error', invalid || none);
    count.classList.toggle('is-error', invalid || none);
    if (!query.search) count.textContent = 'No results';
    else if (invalid) count.textContent = 'Invalid regex';
    else if (total === 0) count.textContent = 'No results';
    else {
      const totalText = matches!.capped ? `${MAX_COUNT}+` : String(total);
      const idx = currentIndex(matches!, view.state);
      count.textContent = `${idx ? idx : '?'} of ${totalText}`;
    }
    count.classList.toggle('is-empty', !query.search);
    for (const b of [prevBtn, nextBtn, allBtn, replaceBtn, replaceAllBtn]) b.disabled = total === 0;
  }

  function onKey(e: KeyboardEvent, inReplace: boolean) {
    if (runScopeHandlers(view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
    } else if (e.key === 'Enter' && inReplace) {
      e.preventDefault();
      if (mod && e.altKey) replaceAll(view);
      else replaceNext(view);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.altKey) selectMatches(view);
      else if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.altKey && !mod && !e.shiftKey) {
      const key = e.key.toLowerCase();
      const opt = key === 'c' ? 'caseSensitive' : key === 'w' ? 'wholeWord' : key === 'r' ? 'regexp' : null;
      if (opt) {
        e.preventDefault();
        toggle(opt);
      }
    }
  }

  searchField.addEventListener('input', () => commit({ search: searchField.value }, true));
  replaceField.addEventListener('input', () => commit({ replace: replaceField.value }, false));
  searchField.addEventListener('keydown', (e) => onKey(e, false));
  replaceField.addEventListener('keydown', (e) => onKey(e, true));
  dom.addEventListener('keydown', (e) => {
    if (e.target === searchField || e.target === replaceField) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
    }
  });

  render();

  return {
    dom,
    top: true,
    mount() {
      searchField.select();
    },
    update(u: ViewUpdate) {
      let queryChanged = false;
      for (const tr of u.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery)) {
            queryChanged = true;
            query = effect.value;
            if (searchField.value !== query.search) searchField.value = query.search;
            if (replaceField.value !== query.replace) replaceField.value = query.replace;
          }
        }
      }
      if (queryChanged || u.docChanged) matches = collectMatches(u.state, query);
      if (queryChanged || u.docChanged || u.selectionSet) render();
    },
  };
}
