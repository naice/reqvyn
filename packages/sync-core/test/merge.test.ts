import { describe, expect, it } from 'vitest';
import { createEntity, emptySnapshot, type JsonObject, type SyncSnapshot } from '@reqvyn/provider-sdk';
import { mergeFields, mergeSnapshots, rebaseAfterPull, resolveConflicts } from '../src/index.js';

type Req = { name: string; url?: string; parentId?: string | null; [k: string]: unknown };

function snap(items: Record<string, Req | { folder: true; name: string; parentId?: string | null }>, tombstones: SyncSnapshot['tombstones'] = []): SyncSnapshot {
  const s = emptySnapshot('c');
  s.entities.c = createEntity('collection', { id: 'c', name: 'C' });
  for (const [id, v] of Object.entries(items)) {
    if ('folder' in v) s.entities[id] = createEntity('folder', { id, name: v.name, parentId: v.parentId ?? null });
    else s.entities[id] = createEntity('request', { id, parentId: null, ...v } as JsonObject);
  }
  s.tombstones = tombstones;
  return s;
}

const name = (s: SyncSnapshot, id: string) => (s.entities[id]?.data as { name?: string } | undefined)?.name;

describe('mergeFields', () => {
  it('combines non-overlapping field changes and reports overlapping ones', () => {
    const base = { name: 'a', url: 'u', meta: { updatedAt: '1', createdAt: '0' } };
    expect(mergeFields(base, { ...base, name: 'L', meta: { createdAt: '0', updatedAt: '2' } }, { ...base, url: 'R', meta: { createdAt: '0', updatedAt: '3' } })).toEqual({
      ok: true,
      value: { name: 'L', url: 'R', meta: { createdAt: '0', updatedAt: '3' } },
    });
    expect(mergeFields(base, { ...base, name: 'L' }, { ...base, name: 'R' })).toEqual({ ok: false, fields: ['name'] });
  });
});

describe('mergeSnapshots', () => {
  const base = snap({ r1: { name: 'one', url: 'u1' }, r2: { name: 'two' }, r3: { name: 'three' } });

  it('takes one-sided changes from both sides', () => {
    const local = snap({ r1: { name: 'one-L', url: 'u1' }, r2: { name: 'two' }, r3: { name: 'three' }, l: { name: 'new local' } });
    const remote = snap({ r1: { name: 'one', url: 'u1' }, r2: { name: 'two-R' }, rn: { name: 'new remote' } }, [
      { id: 'r3', kind: 'request', deletedAt: '2026-01-01T00:00:00.000Z', revisionAt: null },
    ]);
    const m = mergeSnapshots({ base, local, remote });
    expect(m.conflicts).toEqual([]);
    expect(name(m.merged, 'r1')).toBe('one-L');
    expect(name(m.merged, 'r2')).toBe('two-R');
    expect(m.merged.entities.r3).toBeUndefined();
    expect(name(m.merged, 'l')).toBe('new local');
    expect(name(m.merged, 'rn')).toBe('new remote');
    expect(m.localChanges).toEqual({ added: ['rn'], updated: ['r2'], deleted: ['r3'] });
    expect(m.remoteChanges).toEqual({ added: ['l'], updated: ['r1'], deleted: [] });
  });

  it('auto-merges different fields of the same entity', () => {
    const local = snap({ r1: { name: 'renamed', url: 'u1' }, r2: { name: 'two' }, r3: { name: 'three' } });
    const remote = snap({ r1: { name: 'one', url: 'changed' }, r2: { name: 'two' }, r3: { name: 'three' } });
    const m = mergeSnapshots({ base, local, remote });
    expect(m.conflicts).toEqual([]);
    expect(m.autoMerged).toEqual(['r1']);
    expect(m.merged.entities.r1!.data).toMatchObject({ name: 'renamed', url: 'changed' });
    expect(mergeSnapshots({ base, local, remote }, { fieldMerge: false }).conflicts.map((c) => c.id)).toEqual(['r1']);
  });

  it('reports edit-edit, delete-edit and edit-delete conflicts and keeps local data', () => {
    const local = snap({ r1: { name: 'L', url: 'u1' }, r3: { name: 'three-L' } });
    const remote = snap({ r1: { name: 'R', url: 'u1' }, r2: { name: 'two-R' } });
    const m = mergeSnapshots({ base, local, remote });
    const byId = Object.fromEntries(m.conflicts.map((c) => [c.id, c]));
    expect(byId.r1).toMatchObject({ type: 'edit-edit', fields: ['name'] });
    expect(byId.r2).toMatchObject({ type: 'delete-edit' });
    expect(byId.r3).toMatchObject({ type: 'edit-delete' });
    expect(name(m.merged, 'r1')).toBe('L');
    expect(m.merged.entities.r2).toBeUndefined();
    expect(name(m.merged, 'r3')).toBe('three-L');

    const resolved = resolveConflicts(m, { r1: 'remote', r2: 'remote', r3: { choice: 'merged', mergedData: { id: 'r3', name: 'merged', parentId: null } } });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.resolved.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(name(resolved.merged, 'r1')).toBe('R');
    expect(name(resolved.merged, 'r2')).toBe('two-R');
    expect(name(resolved.merged, 'r3')).toBe('merged');
    const keepLocal = resolveConflicts(m, { r2: 'local' });
    expect(keepLocal.merged.entities.r2).toBeUndefined();
    expect(keepLocal.merged.tombstones.some((t) => t.id === 'r2')).toBe(true);
  });

  it('treats concurrent creation with different content as a conflict and identical as equal', () => {
    const m = mergeSnapshots({ base: null, local: snap({ x: { name: 'L' } }), remote: snap({ x: { name: 'R' } }) });
    expect(m.conflicts.map((c) => [c.id, c.type])).toEqual([['x', 'edit-edit']]);
    expect(mergeSnapshots({ base: null, local: snap({ x: { name: 'same' } }), remote: snap({ x: { name: 'same' } }) }).conflicts).toEqual([]);
  });

  it('never mass-deletes when the remote is missing', () => {
    const m = mergeSnapshots({ base, local: base, remote: null });
    expect(Object.keys(m.merged.entities).sort()).toEqual(['c', 'r1', 'r2', 'r3']);
    expect(m.localChanges).toEqual({ added: [], updated: [], deleted: [] });
    expect(m.warnings.length).toBe(1);
  });

  it('uses tombstone lastHash when the base is missing and garbage-collects old tombstones', () => {
    const r = snap({ r1: { name: 'one', url: 'u1' } });
    const old = { id: 'gone', kind: 'request' as const, deletedAt: '2000-01-01T00:00:00.000Z', revisionAt: null };
    const recent = { id: 'r1', kind: 'request' as const, deletedAt: '2026-06-01T00:00:00.000Z', revisionAt: null, lastHash: r.entities.r1!.hash };
    // Remote still has r1 unchanged; local deleted it without a base (tombstone carries the hash).
    const local = snap({}, [recent, old]);
    const m = mergeSnapshots({ base: null, local, remote: r }, { now: new Date('2026-07-01T00:00:00Z') });
    expect(m.conflicts).toEqual([]);
    expect(m.merged.entities.r1).toBeUndefined();
    expect(m.merged.tombstones.map((t) => t.id)).toEqual(['r1']);
  });

  it('repairs children of deleted folders', () => {
    const b = snap({ f: { folder: true, name: 'F' }, r: { name: 'r', parentId: 'f' } });
    const local = snap({ f: { folder: true, name: 'F' }, r: { name: 'r', parentId: 'f' }, child: { name: 'new child', parentId: 'f' } });
    const remote = snap({ r: { name: 'r', parentId: 'f' } }); // folder deleted remotely… but r still references it
    const m = mergeSnapshots({ base: b, local, remote });
    // The new local child keeps a valid parent (folder resurrected with a warning).
    const parent = (m.merged.entities.child!.data as { parentId: string | null }).parentId;
    expect(parent === null || m.merged.entities[parent] !== undefined).toBe(true);
    expect(m.warnings.length).toBeGreaterThan(0);
  });

  it('rebaseAfterPull keeps the old base for conflicting ids', () => {
    const remote = snap({ r1: { name: 'R', url: 'u1' } });
    const nb = rebaseAfterPull(base, remote, ['r2']);
    expect(name(nb, 'r1')).toBe('R');
    expect(name(nb, 'r2')).toBe('two');
    expect(nb.entities.r3).toBeUndefined();
  });
});
