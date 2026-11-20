// @reqvyn/core references `Buffer` behind a `typeof Buffer !== 'undefined'` guard (Node fallback).
// The webview never has Buffer; declare it so the shared source type-checks without @types/node.
declare const Buffer: { from(data: string, encoding: string): { toString(encoding: string): string } };
