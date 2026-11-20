import { canonicalJson } from '@reqvyn/shared';
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type SyncEntity,
  type SyncEntityKind,
  type SyncSnapshot,
  type SyncTombstone,
} from '@reqvyn/provider-sdk';
import { toEntity } from './convert.js';

/**
 * Three-way merge of sync snapshots at entity level (stable ids).
 *
 * For every id, the state on each side is the entity hash or "absent":
 * - local == remote                → take it (includes delete vs delete)
 * - local == base, remote changed  → take remote (incl. remote deletion)
 * - remote == base, local changed  → take local (incl. local deletion)
 * - both changed differently:
 *     both present + base present  → field-level merge of non-overlapping top-level fields,
 *                                    otherwise an `edit-edit` conflict
 *     both present, no base        → `edit-edit` conflict (concurrent creation)
 *     one deleted, one modified    → `delete-edit` / `edit-delete` conflict
 *
 * Unresolved conflicts keep the LOCAL state in `merged`, so applying `merged` locally never loses
 * local data, and nothing divergent is ever overwritten silently.
 */

/** Conflict kinds. `delete-edit`: deleted locally, edited remotely; `edit-delete`: the opposite. */
export type ConflictType = 'edit-edit' | 'delete-edit' | 'edit-delete';

export interface SyncConflict {
  id: string;
  kind: SyncEntityKind;
  type: ConflictType;
  base: SyncEntity | null;
  local: SyncEntity | null;
  remote: SyncEntity | null;
  /** Top-level fields changed on both sides differently (for `edit-edit`). */
  fields?: string[];
  /** Human-readable label (entity name) for UIs. */
  label?: string;
}

/** User decision for one conflict. `merged` requires `mergedData` (the full entity payload). */
export type ConflictChoice = 'local' | 'remote' | 'merged';
export type ConflictDecision = ConflictChoice | { choice: ConflictChoice; mergedData?: JsonValue };

export interface ChangeSet {
  added: string[];
  updated: string[];
  deleted: string[];
}

export interface MergeWarning {
  id: string;
  message: string;
}

export interface MergeInput {
  /** Last synchronized state (common ancestor), `null` for the first synchronization. */
  base: SyncSnapshot | null;
  local: SyncSnapshot;
  /** Remote state; `null` when the collection does not exist remotely. */
  remote: SyncSnapshot | null;
}

export interface MergeOptions {
  decisions?: Record<string, ConflictDecision>;
  /** Drop tombstones older than this many ms (default 90 days). `Infinity` keeps them forever. */
  tombstoneMaxAgeMs?: number;
  /** Clock for tombstones created during the merge. */
  now?: Date;
  /** Disable field-level auto merge (every concurrent edit becomes a conflict). */
  fieldMerge?: boolean;
}

export interface MergeResult {
  input: MergeInput;
  options: MergeOptions;
  /** Result snapshot (revision `null`). Contains local state for unresolved conflicts. */
  merged: SyncSnapshot;
  conflicts: SyncConflict[];
  /** Ids merged automatically at field level. */
  autoMerged: string[];
  /** Ids resolved through `decisions`. */
  resolved: string[];
  warnings: MergeWarning[];
  /** What changes when `merged` is applied locally. */
  localChanges: ChangeSet;
  /** What changes when `merged` is pushed. */
  remoteChanges: ChangeSet;
}

export const DEFAULT_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const ABSENT = '\u0000absent';

function canon(v: JsonValue | undefined): string {
  return v === undefined ? ABSENT : canonicalJson(v);
}

/** Result of a field-level three-way merge. */
export type FieldMergeResult = { ok: true; value: JsonObject } | { ok: false; fields: string[] };

/**
 * Three-way merge of the top-level fields of an entity payload. Non-overlapping changes are
 * combined; a field changed on both sides to different values is a conflict. `meta` is merged one
 * level deeper and `meta.updatedAt` takes the later timestamp, so bookkeeping does not block merges.
 */
export function mergeFields(base: JsonValue, local: JsonValue, remote: JsonValue, path = ''): FieldMergeResult {
  if (!isJsonObject(base) || !isJsonObject(local) || !isJsonObject(remote)) return { ok: false, fields: [path || '<root>'] };
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
  const out: JsonObject = {};
  const conflicts: string[] = [];
  for (const k of keys) {
    const bv = base[k];
    const lv = local[k];
    const rv = remote[k];
    const cb = canon(bv);
    const cl = canon(lv);
    const cr = canon(rv);
    let value: JsonValue | undefined;
    if (cl === cr) value = lv;
    else if (cl === cb) value = rv;
    else if (cr === cb) value = lv;
    else if (path === 'meta' && k === 'updatedAt' && typeof lv === 'string' && typeof rv === 'string') {
      value = lv > rv ? lv : rv;
    } else if (path === '' && k === 'meta' && isJsonObject(lv) && isJsonObject(rv)) {
      const nested = mergeFields(isJsonObject(bv) ? bv : {}, lv, rv, 'meta');
      if (nested.ok) value = nested.value;
      else {
        conflicts.push(...nested.fields);
        continue;
      }
    } else {
      conflicts.push(path ? `${path}.${k}` : k);
      continue;
    }
    if (value !== undefined) out[k] = value;
  }
  return conflicts.length ? { ok: false, fields: conflicts } : { ok: true, value: out };
}

function differingFields(a: JsonValue, b: JsonValue): string[] {
  if (!isJsonObject(a) || !isJsonObject(b)) return [];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => canon(a[k]) !== canon(b[k])).sort();
}

function labelOf(e: SyncEntity | null | undefined): string | undefined {
  if (e && isJsonObject(e.data) && typeof e.data.name === 'string') return e.data.name;
  return undefined;
}

function parentIdOf(e: SyncEntity): string | null {
  if (e.kind === 'collection' || !isJsonObject(e.data)) return null;
  const p = e.data.parentId;
  return typeof p === 'string' && p ? p : null;
}

/** Diff the entity sets of two snapshots (`from` → `to`). */
export function diffSnapshots(from: SyncSnapshot | null, to: SyncSnapshot): ChangeSet {
  const a = from?.entities ?? {};
  const b = to.entities;
  const out: ChangeSet = { added: [], updated: [], deleted: [] };
  for (const id of Object.keys(b).sort()) {
    const prev = a[id];
    if (!prev) out.added.push(id);
    else if (prev.hash !== b[id]!.hash || prev.kind !== b[id]!.kind) out.updated.push(id);
  }
  for (const id of Object.keys(a).sort()) if (!b[id]) out.deleted.push(id);
  return out;
}

export function hasChanges(c: ChangeSet): boolean {
  return c.added.length + c.updated.length + c.deleted.length > 0;
}

function normalizeDecision(d: ConflictDecision): { choice: ConflictChoice; mergedData?: JsonValue } {
  return typeof d === 'string' ? { choice: d } : d;
}

/** Three-way merge (see module documentation). Pure function. */
export function mergeSnapshots(input: MergeInput, options: MergeOptions = {}): MergeResult {
  const { base, local, remote } = input;
  const now = options.now ?? new Date();
  const maxAge = options.tombstoneMaxAgeMs ?? DEFAULT_TOMBSTONE_MAX_AGE_MS;
  const decisions = options.decisions ?? {};
  const fieldMerge = options.fieldMerge ?? true;

  if (!remote) {
    // Nothing remote yet (or the remote copy vanished): never propagate mass deletions, publish local.
    const merged: SyncSnapshot = { ...local, revision: null, entities: { ...local.entities }, tombstones: [...local.tombstones] };
    return {
      input,
      options,
      merged,
      conflicts: [],
      autoMerged: [],
      resolved: [],
      warnings: base ? [{ id: local.collectionId, message: 'Remote collection is missing; it will be re-created from the local copy.' }] : [],
      localChanges: { added: [], updated: [], deleted: [] },
      remoteChanges: diffSnapshots(null, merged),
    };
  }

  const baseEntities = base?.entities ?? {};
  const baseTombs = new Set((base?.tombstones ?? []).map((t) => t.id));
  const localTombs = new Map(local.tombstones.map((t) => [t.id, t]));
  const remoteTombs = new Map(remote.tombstones.map((t) => [t.id, t]));

  const ids = [...new Set([...Object.keys(baseEntities), ...Object.keys(local.entities), ...Object.keys(remote.entities)])].sort();
  const entities: Record<string, SyncEntity> = {};
  const conflicts: SyncConflict[] = [];
  const autoMerged: string[] = [];
  const resolved: string[] = [];
  const warnings: MergeWarning[] = [];
  const deletedNow = new Map<string, SyncTombstone>();

  for (const id of ids) {
    const b = baseEntities[id] ?? null;
    const l = local.entities[id] ?? null;
    const r = remote.entities[id] ?? null;
    let hB = b?.hash ?? null;
    if (!b && !baseTombs.has(id)) {
      // No common ancestor for this id: a tombstone tells us what the deleting side had seen.
      const t = localTombs.get(id) ?? remoteTombs.get(id);
      if (t?.lastHash) hB = t.lastHash;
    }
    const hL = l?.hash ?? null;
    const hR = r?.hash ?? null;

    let result: SyncEntity | null;
    if (hL === hR && (l?.kind ?? null) === (r?.kind ?? null)) result = l;
    else if (hL === hB) result = r;
    else if (hR === hB) result = l;
    else {
      // Both sides changed differently.
      let conflict: SyncConflict | null = null;
      result = l;
      if (l && r) {
        const fm = fieldMerge && b && l.kind === r.kind && b.kind === l.kind ? mergeFields(b.data, l.data, r.data) : null;
        if (fm?.ok) {
          result = toEntity(l.kind, fm.value);
          autoMerged.push(id);
        } else {
          conflict = {
            id,
            kind: l.kind,
            type: 'edit-edit',
            base: b,
            local: l,
            remote: r,
            fields: fm && !fm.ok ? fm.fields : differingFields(l.data, r.data),
          };
        }
      } else {
        conflict = { id, kind: (l ?? r ?? b)!.kind, type: l ? 'edit-delete' : 'delete-edit', base: b, local: l, remote: r };
      }
      if (conflict) {
        conflict.label = labelOf(l) ?? labelOf(r) ?? labelOf(b);
        const decision = decisions[id];
        if (decision) {
          const d = normalizeDecision(decision);
          if (d.choice === 'local') result = l;
          else if (d.choice === 'remote') result = r;
          else {
            if (d.mergedData === undefined) throw new TypeError(`Decision "merged" for ${id} requires mergedData`);
            result = toEntity(conflict.kind, d.mergedData);
          }
          resolved.push(id);
        } else {
          conflicts.push(conflict);
        }
      }
    }
    if (result) entities[id] = result;
    else {
      const prev = l ?? r ?? b;
      if (prev) {
        deletedNow.set(id, {
          id,
          kind: prev.kind,
          deletedAt: now.toISOString(),
          revisionAt: base?.revision ?? null,
          lastHash: b?.hash ?? prev.hash,
        });
      }
    }
  }

  // Structural integrity: an item must not point to a folder that the merge deleted.
  const conflictIds = new Set(conflicts.map((c) => c.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, e] of Object.entries(entities)) {
      const p = parentIdOf(e);
      if (!p || entities[p]) continue;
      const candidate = !decisions[p] && !conflictIds.has(p) ? (local.entities[p] ?? remote.entities[p]) : undefined;
      if (candidate && candidate.kind === 'folder') {
        entities[p] = candidate;
        deletedNow.delete(p);
        warnings.push({ id: p, message: 'Folder was deleted on one side but has new or changed items on the other; it was kept.' });
      } else {
        const data = { ...(e.data as JsonObject), parentId: null };
        entities[id] = toEntity(e.kind, data);
        warnings.push({ id, message: 'Parent folder no longer exists; item moved to the collection root.' });
      }
      changed = true;
    }
  }

  // Tombstones: union of both sides plus deletions from this merge; resurrected ids lose theirs.
  const tombs = new Map<string, SyncTombstone>();
  for (const t of [...remote.tombstones, ...local.tombstones, ...deletedNow.values()]) {
    const prev = tombs.get(t.id);
    if (!prev || t.deletedAt > prev.deletedAt) tombs.set(t.id, t);
  }
  const cutoff = Number.isFinite(maxAge) ? now.getTime() - maxAge : -Infinity;
  const tombstones = [...tombs.values()]
    .filter((t) => !entities[t.id])
    .filter((t) => {
      const ts = Date.parse(t.deletedAt);
      return Number.isNaN(ts) || ts >= cutoff;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const merged: SyncSnapshot = {
    formatVersion: local.formatVersion,
    collectionId: local.collectionId,
    revision: null,
    updatedAt: now.toISOString(),
    label: labelOf(entities[local.collectionId]) ?? local.label ?? remote.label,
    entities,
    tombstones,
  };
  return {
    input,
    options,
    merged,
    conflicts,
    autoMerged,
    resolved,
    warnings,
    localChanges: diffSnapshots(local, merged),
    remoteChanges: diffSnapshots(remote, merged),
  };
}

/**
 * Apply conflict decisions to a previous merge result by re-running the merge with the decisions.
 * Decisions for ids that are not conflicts are ignored. Returns a new result; remaining
 * conflicts stay unresolved.
 */
export function resolveConflicts(result: MergeResult, decisions: Record<string, ConflictDecision>): MergeResult {
  const ids = new Set(result.conflicts.map((c) => c.id));
  const relevant: Record<string, ConflictDecision> = { ...(result.options.decisions ?? {}) };
  for (const [id, d] of Object.entries(decisions)) if (ids.has(id)) relevant[id] = d;
  return mergeSnapshots(result.input, { ...result.options, decisions: relevant });
}

/** Rebuild a base snapshot after a pull without push: remote state, except conflicting ids keep the old base. */
export function rebaseAfterPull(oldBase: SyncSnapshot | null, remote: SyncSnapshot, conflictIds: Iterable<string>): SyncSnapshot {
  const entities = { ...remote.entities };
  const tombstones = new Map(remote.tombstones.map((t) => [t.id, t]));
  for (const id of conflictIds) {
    const b = oldBase?.entities[id];
    if (b) {
      entities[id] = b;
      tombstones.delete(id);
    } else {
      delete entities[id];
      const bt = oldBase?.tombstones.find((t) => t.id === id);
      if (bt) tombstones.set(id, bt);
      else tombstones.delete(id);
    }
  }
  return { ...remote, entities, tombstones: [...tombstones.values()] };
}
