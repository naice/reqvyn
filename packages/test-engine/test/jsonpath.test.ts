import { describe, expect, it } from 'vitest';
import { jsonPath, jsonPathQuery, JsonPathError } from '../src/index.js';

const store = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  'odd key': { 'with.dot': 1 },
  data: { items: [{ id: 7, tags: ['a', 'b'] }, { id: 8, tags: [] }] },
};

describe('jsonPath', () => {
  it('returns the root for $ and empty', () => {
    expect(jsonPath(store, '$')).toEqual([store]);
    expect(jsonPath(store, '')).toEqual([store]);
  });

  it('selects members with dot and bracket notation', () => {
    expect(jsonPath(store, '$.store.bicycle.color')).toEqual(['red']);
    expect(jsonPath(store, "$['store']['bicycle']['color']")).toEqual(['red']);
    expect(jsonPath(store, '$["odd key"]["with.dot"]')).toEqual([1]);
  });

  it('supports implicitly rooted bare paths', () => {
    expect(jsonPath(store, 'data.items[0].id')).toEqual([7]);
    expect(jsonPath(store, 'store.book[-1].title')).toEqual(['The Lord of the Rings']);
    expect(jsonPath(store, '[\'data\'].items[1].id')).toEqual([8]);
  });

  it('supports indexes, negative indexes and unions', () => {
    expect(jsonPath(store, '$.store.book[0].author')).toEqual(['Nigel Rees']);
    expect(jsonPath(store, '$.store.book[-1].author')).toEqual(['J. R. R. Tolkien']);
    expect(jsonPath(store, '$.store.book[0,2].price')).toEqual([8.95, 8.99]);
    expect(jsonPath(store, "$.store.bicycle['color','price']")).toEqual(['red', 19.95]);
    expect(jsonPath(store, '$.store.book[10]')).toEqual([]);
  });

  it('supports wildcards', () => {
    expect(jsonPath(store, '$.store.book[*].author')).toHaveLength(4);
    expect(jsonPath(store, '$.store.bicycle.*')).toEqual(['red', 19.95]);
  });

  it('supports recursive descent', () => {
    expect(jsonPath(store, '$..author')).toEqual(['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
    expect(jsonPath(store, '$..price').sort()).toEqual([12.99, 19.95, 22.99, 8.95, 8.99].sort());
    expect(jsonPath(store, '$..book[2].title')).toEqual(['Moby Dick']);
    expect(jsonPath(store, '$..id')).toEqual([7, 8]);
  });

  it('supports slices', () => {
    expect(jsonPath(store, '$.store.book[0:2].price')).toEqual([8.95, 12.99]);
    expect(jsonPath(store, '$.store.book[-2:].price')).toEqual([8.99, 22.99]);
    expect(jsonPath(store, '$.store.book[:1].price')).toEqual([8.95]);
    expect(jsonPath(store, '$.store.book[::2].price')).toEqual([8.95, 8.99]);
    expect(jsonPath([1, 2, 3, 4], '$[::-1]')).toEqual([4, 3, 2, 1]);
  });

  it('supports filters with comparisons and logic', () => {
    expect(jsonPath(store, '$.store.book[?(@.price < 10)].title')).toEqual(['Sayings of the Century', 'Moby Dick']);
    expect(jsonPath(store, '$.store.book[?(@.isbn)].title')).toEqual(['Moby Dick', 'The Lord of the Rings']);
    expect(jsonPath(store, "$.store.book[?(@.category == 'fiction' && @.price > 20)].author")).toEqual(['J. R. R. Tolkien']);
    expect(jsonPath(store, "$.store.book[?(@.category == 'reference' || @.price >= 22.99)].price")).toEqual([8.95, 22.99]);
    expect(jsonPath(store, '$.store.book[?(@.price != 8.95)]')).toHaveLength(3);
    expect(jsonPath(store, '$.store.book[?(@.price <= 8.99)]')).toHaveLength(2);
    expect(jsonPath(store, '$.store.book[?(@.author =~ /melville/i)].title')).toEqual(['Moby Dick']);
    expect(jsonPath(store, '$.store.book[?(!@.isbn)].title')).toEqual(['Sayings of the Century', 'Sword of Honour']);
    expect(jsonPath(store, '$.store.book[?((@.price < 9) && (@.isbn))].title')).toEqual(['Moby Dick']);
    expect(jsonPath(store, '$.store.book[?(@.price > $.store.bicycle.price)].title')).toEqual(['The Lord of the Rings']);
    expect(jsonPath(store, '$.data.items[?(@.tags.length > 0)].id')).toEqual([7]);
    expect(jsonPath([{ a: true }, { a: false }, { a: null }], '$[?(@.a == true)]')).toEqual([{ a: true }]);
    expect(jsonPath([{ a: null }, { b: 1 }], '$[?(@.a == null)]')).toEqual([{ a: null }]);
  });

  it('reports definiteness', () => {
    expect(jsonPathQuery(store, '$.store.bicycle.color').definite).toBe(true);
    expect(jsonPathQuery(store, '$..color').definite).toBe(false);
    expect(jsonPathQuery(store, '$.store.book[*]').definite).toBe(false);
  });

  it('handles non-object data gracefully', () => {
    expect(jsonPath(null, '$.a')).toEqual([]);
    expect(jsonPath('str', '$.length')).toEqual([3]);
    expect(jsonPath([1, 2], '$.length')).toEqual([2]);
  });

  it('throws JsonPathError on invalid syntax', () => {
    expect(() => jsonPath(store, '$.store[')).toThrow(JsonPathError);
    expect(() => jsonPath(store, '$..')).toThrow(JsonPathError);
    expect(() => jsonPath(store, "$['unterminated")).toThrow(/unterminated/);
    expect(() => jsonPath(store, '$[?(@.a =~ "x")]')).toThrow(/regex/);
    expect(() => jsonPath(store, '$.a b')).toThrow(JsonPathError);
  });
});
