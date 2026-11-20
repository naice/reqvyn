/**
 * `@reqvyn/provider-filesystem` – shared building blocks for file-based sync remotes:
 * directory layout, journaled atomic writes with crash recovery, and a lock file for concurrent
 * writers on local disks, network shares and removable drives.
 */
export * from './atomic.js';
export * from './lock.js';
export * from './layout.js';
export * from './store.js';
