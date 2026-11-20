/**
 * Source of the bootstrap evaluated INSIDE the fresh `vm` context (context realm). It builds the
 * `reqvyn` / `pm` / `console` APIs entirely out of context-realm objects so that user code can never
 * reach a host-realm function (whose `.constructor` would be a Function able to compile strings).
 *
 * The bootstrap evaluates to `init(inputJson, hostLog, hostTimer, hostDone, userFn, compileError)`.
 * Host callbacks are captured in this closure only and are never exposed to user code; they only
 * receive/return primitive values.
 *
 * NOTE: this file is embedded as a string. Do not use backticks or dollar-brace sequences inside it.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function () {
'use strict';
var _parse = JSON.parse;
var _stringify = JSON.stringify;
var _Promise = Promise;
var _freeze = Object.freeze;
var _defineProperty = Object.defineProperty;
var _keys = Object.keys;
var _hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
var _isArray = Array.isArray;
var _String = String;
var _Number = Number;
var _Error = Error;
var _RegExp = RegExp;
var _Proxy = Proxy;
var _now = Date.now;
var SCRIPT_FILE = 'reqvyn-script.js';
var MAX_SLEEP = 2000;
var MAX_CHANGES = 10000;
var MAX_TESTS = 10000;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    _freeze(o);
    var ks = Object.getOwnPropertyNames(o);
    for (var i = 0; i < ks.length; i++) {
      var d = Object.getOwnPropertyDescriptor(o, ks[i]);
      if (d && 'value' in d) deepFreeze(d.value);
    }
  }
  return o;
}

function fmt(v, depth) {
  depth = depth || 0;
  try {
    if (typeof v === 'string') return depth ? _stringify(v) : v;
    if (typeof v === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (typeof v === 'undefined') return 'undefined';
    if (typeof v === 'bigint') return _String(v) + 'n';
    if (typeof v === 'symbol') return v.toString();
    if (v instanceof _Error) return (v.name || 'Error') + ': ' + v.message;
    if (v instanceof _RegExp) return v.toString();
    if (typeof v === 'object' && v !== null) {
      var seen = [];
      var s = _stringify(v, function (k, val) {
        if (typeof val === 'object' && val !== null) {
          if (seen.indexOf(val) >= 0) return '[Circular]';
          seen.push(val);
        }
        if (typeof val === 'function') return '[Function]';
        if (typeof val === 'undefined') return '[undefined]';
        if (typeof val === 'bigint') return _String(val) + 'n';
        return val;
      });
      return s === undefined ? _String(v) : s;
    }
    return _String(v);
  } catch (e) {
    return '[unprintable]';
  }
}

function preview(v) {
  var s = typeof v === 'string' ? _stringify(v) : fmt(v, 1);
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

function lineOf(e) {
  try {
    var st = e && typeof e === 'object' ? e.stack : undefined;
    if (typeof st !== 'string') return undefined;
    var m = /reqvyn-script\.js:(\d+)/.exec(st);
    if (m) { var n = _Number(m[1]); return n >= 1 ? n : 1; }
  } catch (x) { /* ignore */ }
  return undefined;
}

function describe(e) {
  var message;
  try {
    if (e && typeof e === 'object' && typeof e.message === 'string') {
      var name = typeof e.name === 'string' && e.name !== 'Error' && e.name !== 'AssertionError' ? e.name + ': ' : '';
      message = name + e.message;
    } else message = 'Uncaught ' + fmt(e, 1);
  } catch (x) { message = 'Uncaught exception'; }
  var out = { message: _String(message).slice(0, 4000) };
  var line = lineOf(e);
  if (line !== undefined) out.line = line;
  return out;
}

function assertionError(msg) {
  var e = new _Error(msg);
  e.name = 'AssertionError';
  return e;
}

function deepEqual(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (_isArray(a) !== _isArray(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof _RegExp && b instanceof _RegExp) return a.toString() === b.toString();
  seen = seen || [];
  for (var i = 0; i < seen.length; i++) if (seen[i][0] === a && seen[i][1] === b) return true;
  seen.push([a, b]);
  var ka = _keys(a), kb = _keys(b);
  if (ka.length !== kb.length) return false;
  for (var j = 0; j < ka.length; j++) {
    if (!_hasOwn(b, ka[j]) || !deepEqual(a[ka[j]], b[ka[j]], seen)) return false;
  }
  return true;
}

function parsePropPath(path) {
  if (_isArray(path)) return path.map(_String);
  var out = [];
  var re = /[^.[\]]+|\[(\d+)\]|\[["']([^"']*)["']\]/g;
  var m;
  var s = _String(path);
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[0]);
  return out;
}

function getPath(obj, path) {
  var parts = parsePropPath(path);
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return { found: false };
    if (typeof cur !== 'object' && typeof cur !== 'string') return { found: false };
    if (typeof cur === 'string') {
      if (parts[i] === 'length') { cur = cur.length; continue; }
      return { found: false };
    }
    if (!(parts[i] in cur)) return { found: false };
    cur = cur[parts[i]];
  }
  return { found: true, value: cur };
}

function lengthOf(v) {
  if (typeof v === 'string' || _isArray(v)) return v.length;
  if (v && typeof v === 'object' && typeof v.length === 'number') return v.length;
  return undefined;
}

function contains(actual, item) {
  if (typeof actual === 'string') return actual.indexOf(_String(item)) >= 0;
  if (_isArray(actual)) {
    for (var i = 0; i < actual.length; i++) if (deepEqual(actual[i], item)) return true;
    return false;
  }
  if (actual && typeof actual === 'object') {
    if (typeof item === 'string') return _hasOwn(actual, item);
    if (item && typeof item === 'object') {
      var ks = _keys(item);
      for (var j = 0; j < ks.length; j++) if (!deepEqual(actual[ks[j]], item[ks[j]])) return false;
      return true;
    }
  }
  return false;
}

function requireNumber(v, what) {
  if (typeof v !== 'number' || v !== v) throw assertionError('Expected ' + preview(v) + ' to be a number for ' + what);
}

// ------------------------------------------------------------------------------------------
// reqvyn.expect (jest-like)
// ------------------------------------------------------------------------------------------
function makeExpect(actual, negate) {
  function check(cond, msg) {
    if (negate ? cond : !cond) throw assertionError('Expected ' + preview(actual) + (negate ? ' not ' : ' ') + msg);
  }
  var api = {
    toBe: function (e) { check(Object.is(actual, e), 'to be ' + preview(e)); },
    toEqual: function (e) { check(deepEqual(actual, e), 'to equal ' + preview(e)); },
    toStrictEqual: function (e) { check(deepEqual(actual, e), 'to equal ' + preview(e)); },
    toContain: function (e) { check(contains(actual, e), 'to contain ' + preview(e)); },
    toMatch: function (e) {
      var ok = e instanceof _RegExp ? (e.lastIndex = 0, e.test(_String(actual))) : _String(actual).indexOf(_String(e)) >= 0;
      check(ok, 'to match ' + (e instanceof _RegExp ? e.toString() : preview(e)));
    },
    toBeGreaterThan: function (e) { requireNumber(actual, 'toBeGreaterThan'); check(actual > e, 'to be greater than ' + preview(e)); },
    toBeGreaterThanOrEqual: function (e) { requireNumber(actual, 'toBeGreaterThanOrEqual'); check(actual >= e, 'to be greater than or equal to ' + preview(e)); },
    toBeLessThan: function (e) { requireNumber(actual, 'toBeLessThan'); check(actual < e, 'to be less than ' + preview(e)); },
    toBeLessThanOrEqual: function (e) { requireNumber(actual, 'toBeLessThanOrEqual'); check(actual <= e, 'to be less than or equal to ' + preview(e)); },
    toBeDefined: function () { check(actual !== undefined, 'to be defined'); },
    toBeUndefined: function () { check(actual === undefined, 'to be undefined'); },
    toBeNull: function () { check(actual === null, 'to be null'); },
    toBeTruthy: function () { check(!!actual, 'to be truthy'); },
    toBeFalsy: function () { check(!actual, 'to be falsy'); },
    toBeNaN: function () { check(actual !== actual, 'to be NaN'); },
    toHaveProperty: function (path, value) {
      var r = getPath(actual, path);
      if (arguments.length < 2) check(r.found, 'to have property ' + preview(path));
      else check(r.found && deepEqual(r.value, value), 'to have property ' + preview(path) + ' equal to ' + preview(value) + (r.found ? ' (found ' + preview(r.value) + ')' : ''));
    },
    toHaveLength: function (n) {
      var len = lengthOf(actual);
      check(len === n, 'to have length ' + n + (len === undefined ? ' (value has no length)' : ' (length is ' + len + ')'));
    },
    toBeOneOf: function (list) {
      if (!_isArray(list)) throw assertionError('toBeOneOf expects an array');
      var ok = false;
      for (var i = 0; i < list.length; i++) if (deepEqual(actual, list[i])) ok = true;
      check(ok, 'to be one of ' + preview(list));
    },
    toBeInstanceOf: function (C) { check(typeof C === 'function' && actual instanceof C, 'to be an instance of ' + (C && C.name)); },
    toBeTypeOf: function (t) { check((actual === null ? 'null' : _isArray(actual) ? 'array' : typeof actual) === t, 'to be of type ' + t); },
    toThrow: function (m) {
      if (typeof actual !== 'function') throw assertionError('toThrow expects a function');
      var threw = false, err;
      try { actual(); } catch (e) { threw = true; err = e; }
      var ok = threw && (m === undefined || (m instanceof _RegExp ? m.test(describe(err).message) : describe(err).message.indexOf(_String(m)) >= 0));
      if (negate ? ok : !ok) throw assertionError('Expected function ' + (negate ? 'not ' : '') + 'to throw' + (m !== undefined ? ' ' + preview(m) : '') + (threw ? ' (threw ' + preview(describe(err).message) + ')' : ''));
    }
  };
  if (!negate) api.not = makeExpect(actual, true);
  return _freeze(api);
}

// ------------------------------------------------------------------------------------------
// pm.expect (chai-like subset)
// ------------------------------------------------------------------------------------------
var CHAI_WORDS = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also', 'own', 'nested', 'any', 'all'];
var RESPONSE_MARK = {};

function chai(actual, flags) {
  flags = flags || { negate: false, deep: false };
  var target = {};
  function assert(cond, msg) {
    if (flags.negate ? cond : !cond) throw assertionError('expected ' + preview(actual === RESPONSE_MARK ? 'response' : actual) + (flags.negate ? ' not ' : ' ') + msg);
  }
  function next(newActual) { return chai(newActual === undefined ? actual : newActual, { negate: false, deep: false }); }
  function self() { return proxy; }
  var methods = {
    equal: function (e) { assert(flags.deep ? deepEqual(actual, e) : Object.is(actual, e) || actual === e, 'to ' + (flags.deep ? 'deeply ' : '') + 'equal ' + preview(e)); return self(); },
    eql: function (e) { assert(deepEqual(actual, e), 'to deeply equal ' + preview(e)); return self(); },
    above: function (n) { requireNumber(actual, 'above'); assert(actual > n, 'to be above ' + n); return self(); },
    below: function (n) { requireNumber(actual, 'below'); assert(actual < n, 'to be below ' + n); return self(); },
    least: function (n) { requireNumber(actual, 'least'); assert(actual >= n, 'to be at least ' + n); return self(); },
    most: function (n) { requireNumber(actual, 'most'); assert(actual <= n, 'to be at most ' + n); return self(); },
    within: function (a, b) { requireNumber(actual, 'within'); assert(actual >= a && actual <= b, 'to be within ' + a + '..' + b); return self(); },
    include: function (e) { assert(contains(actual, e), 'to include ' + preview(e)); return self(); },
    string: function (e) { assert(typeof actual === 'string' && actual.indexOf(e) >= 0, 'to have string ' + preview(e)); return self(); },
    property: function (name, value) {
      var r = getPath(actual, flags.nested ? name : [name]);
      if (arguments.length < 2) assert(r.found, 'to have property ' + preview(name));
      else assert(r.found && deepEqual(r.value, value), 'to have property ' + preview(name) + ' of ' + preview(value) + (r.found ? ' but got ' + preview(r.value) : ''));
      return flags.negate ? self() : next(r.value);
    },
    lengthOf: function (n) { var len = lengthOf(actual); assert(len === n, 'to have length ' + n + (len === undefined ? '' : ' but got ' + len)); return self(); },
    a: function (t) {
      var actualType = actual === null ? 'null' : _isArray(actual) ? 'array' : typeof actual;
      assert(actualType === _String(t).toLowerCase(), 'to be a' + (/^[aeiou]/i.test(t) ? 'n ' : ' ') + t);
      return self();
    },
    match: function (re) { assert(re instanceof _RegExp && (re.lastIndex = 0, re.test(_String(actual))), 'to match ' + _String(re)); return self(); },
    oneOf: function (list) {
      var ok = false;
      if (_isArray(list)) for (var i = 0; i < list.length; i++) if (deepEqual(actual, list[i])) ok = true;
      assert(ok, 'to be one of ' + preview(list));
      return self();
    },
    keys: function () {
      var want = arguments.length === 1 && _isArray(arguments[0]) ? arguments[0] : Array.prototype.slice.call(arguments);
      var ok = actual && typeof actual === 'object';
      for (var i = 0; ok && i < want.length; i++) if (!_hasOwn(actual, want[i])) ok = false;
      assert(ok, 'to have keys ' + preview(want));
      return self();
    },
    status: function (code) {
      var c = actual === RESPONSE_MARK ? responseCode() : actual && typeof actual === 'object' ? (actual.code !== undefined ? actual.code : actual.status) : actual;
      if (typeof code === 'string') {
        var t = actual === RESPONSE_MARK ? responseStatusText() : '';
        if (flags.negate ? t === code : t !== code) throw assertionError('expected response to ' + (flags.negate ? 'not ' : '') + 'have status ' + preview(code) + ' but got ' + preview(t));
        return self();
      }
      if (flags.negate ? c === code : c !== code) throw assertionError('expected response to ' + (flags.negate ? 'not ' : '') + 'have status code ' + code + ' but got ' + c);
      return self();
    },
    header: function (name, value) {
      var v = actual === RESPONSE_MARK ? responseHeader(name) : undefined;
      if (arguments.length < 2) assert(v !== undefined, 'to have header ' + preview(name));
      else assert(v === value, 'to have header ' + preview(name) + ' with value ' + preview(value) + (v !== undefined ? ' but got ' + preview(v) : ''));
      return self();
    }
  };
  methods.equals = methods.eq = methods.equal;
  methods.eqls = methods.eql;
  methods.gt = methods.greaterThan = methods.above;
  methods.lt = methods.lessThan = methods.below;
  methods.gte = methods.greaterThanOrEqual = methods.least;
  methods.lte = methods.lessThanOrEqual = methods.most;
  methods.includes = methods.contain = methods.contains = methods.include;
  methods.length = methods.lengthOf;
  methods.an = methods.a;
  methods.matches = methods.match;

  var props = {
    'true': function () { assert(actual === true, 'to be true'); },
    'false': function () { assert(actual === false, 'to be false'); },
    'null': function () { assert(actual === null, 'to be null'); },
    'undefined': function () { assert(actual === undefined, 'to be undefined'); },
    'NaN': function () { assert(actual !== actual, 'to be NaN'); },
    exist: function () { assert(actual !== null && actual !== undefined, 'to exist'); },
    ok: function () {
      if (actual === RESPONSE_MARK) { var c = responseCode(); assert(c >= 200 && c < 300, 'to be ok (2xx) but status was ' + c); }
      else assert(!!actual, 'to be truthy');
    },
    empty: function () {
      var len = lengthOf(actual);
      if (len === undefined && actual && typeof actual === 'object') len = _keys(actual).length;
      assert(len === 0, 'to be empty');
    },
    json: function () {
      var ok = true;
      try { if (actual === RESPONSE_MARK) responseJson(); else _parse(_String(actual)); } catch (e) { ok = false; }
      assert(ok, 'to be valid JSON');
    }
  };
  var proxy = new _Proxy(target, {
    get: function (t, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON' || prop === 'constructor' || prop === 'inspect') return undefined;
      if (prop === 'not') return chai(actual, { negate: !flags.negate, deep: flags.deep, nested: flags.nested });
      if (prop === 'deep') return chai(actual, { negate: flags.negate, deep: true, nested: flags.nested });
      if (prop === 'nested') return chai(actual, { negate: flags.negate, deep: flags.deep, nested: true });
      if (CHAI_WORDS.indexOf(prop) >= 0) return proxy;
      if (_hasOwn(methods, prop)) return methods[prop];
      if (_hasOwn(props, prop)) { props[prop](); return proxy; }
      throw new _Error('pm.expect: unsupported assertion ".' + prop + '". REQVYN supports a subset of chai; consider reqvyn.expect().');
    },
    set: function () { return false; },
    has: function (t, prop) { return CHAI_WORDS.indexOf(prop) >= 0 || _hasOwn(methods, prop) || _hasOwn(props, prop); }
  });
  return proxy;
}

var responseCode, responseStatusText, responseHeader, responseJson;

function toBase64(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  str = _String(str);
  var out = '';
  for (var i = 0; i < str.length; i += 3) {
    var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
    if (a > 255 || b > 255 || c > 255) throw new _Error('btoa: string contains characters outside of the Latin1 range');
    var n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63) + (i + 1 < str.length ? chars.charAt((n >> 6) & 63) : '=') + (i + 2 < str.length ? chars.charAt(n & 63) : '=');
  }
  return out;
}

function fromBase64(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  str = _String(str).replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  var out = '';
  var bits = 0, acc = 0;
  for (var i = 0; i < str.length; i++) {
    var v = chars.indexOf(str.charAt(i));
    if (v < 0) throw new _Error('atob: invalid base64 input');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += _String.fromCharCode((acc >> bits) & 255); }
  }
  return out;
}

return function init(inputJson, hostLog, hostTimer, hostDone, userFn, compileError) {
  var input = _parse(inputJson);
  var phase = input.phase === 'post' ? 'post' : 'pre';
  var started = _now();
  var snapshot = input.variables || {};
  var scopes = input.scopes || {};
  var changes = {};
  var changeOrder = [];
  var tests = [];
  var pending = [];
  var skip = false;
  var done = false;
  var req = {
    method: _String(input.request.method || 'GET'),
    url: _String(input.request.url || ''),
    headers: (input.request.headers || []).map(function (h) { return [_String(h[0]), _String(h[1])]; }),
    body: input.request.body
  };
  var res = input.response;

  // ---- variables ----
  function ckey(scope, key) { return scope + '\u0000' + key; }
  function change(scope, key) { var c = changes[ckey(scope, key)]; return c; }
  function base(scope) {
    if (scopes[scope] && typeof scopes[scope] === 'object') return scopes[scope];
    return snapshot;
  }
  function str(v) {
    if (typeof v === 'string') return v;
    if (v === undefined) return '';
    if ((typeof v === 'object' && v !== null) || typeof v === 'function') return fmt(v, 1);
    return _String(v);
  }
  function checkKey(key) {
    if (typeof key !== 'string' || key === '') throw new _Error('Variable name must be a non-empty string');
    return key;
  }
  function record(scope, key, value) {
    var k = ckey(scope, key);
    if (!changes[k]) {
      if (changeOrder.length >= MAX_CHANGES) throw new _Error('Too many variable changes');
      changeOrder.push(k);
    }
    changes[k] = { scope: scope, key: key, value: value };
  }
  function scopeGet(scope, key) {
    var c = change(scope, key);
    if (c) return c.value === null ? undefined : c.value;
    var b = base(scope);
    return _hasOwn(b, key) ? b[key] : undefined;
  }
  function resolveVisible(key) {
    var c = change('runtime', key);
    if (c && c.value !== null) return c.value;
    if (!c && scopes.runtime && _hasOwn(scopes.runtime, key)) return scopes.runtime[key];
    var order = ['environment', 'collection', 'global'];
    for (var i = 0; i < order.length; i++) {
      var oc = change(order[i], key);
      if (oc && oc.value !== null) return oc.value;
    }
    if (c) {
      for (var j = 0; j < order.length; j++) {
        var s = scopes[order[j]];
        if (s && _hasOwn(s, key) && !change(order[j], key)) return s[key];
      }
      return undefined;
    }
    return _hasOwn(snapshot, key) ? snapshot[key] : undefined;
  }
  function replaceIn(text) {
    return _String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, name) {
      var v = resolveVisible(name);
      return v === undefined ? m : v;
    });
  }
  function scopeApi(scope, visible) {
    var get = visible ? function (k) { return resolveVisible(_String(k)); } : function (k) { return scopeGet(scope, _String(k)); };
    return _freeze({
      get: get,
      set: function (k, v) { record(scope, checkKey(k), str(v)); },
      unset: function (k) { record(scope, checkKey(k), null); },
      has: function (k) { return get(k) !== undefined; },
      replaceIn: replaceIn,
      toObject: function () {
        var out = {};
        var b = visible ? snapshot : base(scope);
        var ks = _keys(b);
        for (var i = 0; i < ks.length; i++) out[ks[i]] = b[ks[i]];
        for (var j = 0; j < changeOrder.length; j++) {
          var c = changes[changeOrder[j]];
          if (c.scope !== scope) continue;
          if (c.value === null) delete out[c.key]; else out[c.key] = c.value;
        }
        return out;
      }
    });
  }
  var envApi = scopeApi('environment', false);
  var varApi = scopeApi('runtime', true);
  var collApi = scopeApi('collection', false);
  var globApi = scopeApi('global', false);

  // ---- request ----
  function mutable(what) {
    if (phase !== 'pre') throw new _Error(what + ' can only be modified in pre-request scripts');
  }
  function findHeader(name) {
    var lower = _String(name).toLowerCase();
    for (var i = 0; i < req.headers.length; i++) if (req.headers[i][0].toLowerCase() === lower) return i;
    return -1;
  }
  function headerGet(name) { var i = findHeader(name); return i < 0 ? undefined : req.headers[i][1]; }
  function headerSet(name, value) {
    mutable('Request headers');
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(name)) throw new _Error('Invalid header name: ' + preview(name));
    var v = str(value);
    if (/[\r\n]/.test(v)) throw new _Error('Header values must not contain line breaks');
    var i = findHeader(name);
    if (i < 0) { req.headers.push([name, v]); return; }
    req.headers[i] = [name, v];
    var lower = name.toLowerCase();
    req.headers = req.headers.filter(function (h, idx) { return idx <= i || h[0].toLowerCase() !== lower; });
  }
  function headerRemove(name) {
    mutable('Request headers');
    var lower = _String(name).toLowerCase();
    req.headers = req.headers.filter(function (h) { return h[0].toLowerCase() !== lower; });
  }
  function headerObject() {
    var o = {};
    for (var i = 0; i < req.headers.length; i++) if (!_hasOwn(o, req.headers[i][0])) o[req.headers[i][0]] = req.headers[i][1];
    return o;
  }
  var reqHeaders = _freeze({
    get: headerGet, set: headerSet, remove: headerRemove, has: function (n) { return findHeader(n) >= 0; },
    toObject: headerObject,
    add: function (h, v) { if (h && typeof h === 'object') headerSet(h.key, h.value); else headerSet(h, v); },
    upsert: function (h, v) { if (h && typeof h === 'object') headerSet(h.key, h.value); else headerSet(h, v); }
  });
  var request = {};
  _defineProperty(request, 'method', { enumerable: true, get: function () { return req.method; }, set: function (v) { mutable('reqvyn.request.method'); var m = _String(v).toUpperCase(); if (!/^[A-Z][A-Z0-9_-]*$/.test(m)) throw new _Error('Invalid HTTP method'); req.method = m; } });
  _defineProperty(request, 'url', { enumerable: true, get: function () { return req.url; }, set: function (v) { mutable('reqvyn.request.url'); req.url = _String(v); } });
  _defineProperty(request, 'body', { enumerable: true, get: function () { return req.body; }, set: function (v) { mutable('reqvyn.request.body'); req.body = v === undefined || v === null ? undefined : str(v); } });
  _defineProperty(request, 'headers', { enumerable: true, value: reqHeaders });
  _freeze(request);

  // ---- response ----
  var response;
  var parsedJson, parsedOk = false;
  function bodyJson() {
    if (!res) throw new _Error('No response is available in pre-request scripts');
    if (!parsedOk) {
      try { parsedJson = _parse(res.bodyText); } catch (e) { throw new _Error('Response body is not valid JSON: ' + e.message); }
      parsedOk = true;
    }
    return parsedJson;
  }
  function resHeader(name) {
    if (!res) return undefined;
    var lower = _String(name).toLowerCase();
    var vals = [];
    for (var i = 0; i < res.headers.length; i++) if (res.headers[i][0].toLowerCase() === lower) vals.push(res.headers[i][1]);
    return vals.length ? vals.join(', ') : undefined;
  }
  function resCookie(name) {
    if (!res) return undefined;
    for (var i = 0; i < res.cookies.length; i++) if (res.cookies[i].name === name) return res.cookies[i].value;
    return undefined;
  }
  responseCode = function () { return res ? res.status : undefined; };
  responseStatusText = function () { return res ? res.statusText : undefined; };
  responseHeader = resHeader;
  responseJson = bodyJson;
  if (res) {
    var resHeadersApi = _freeze({
      get: resHeader,
      has: function (n) { return resHeader(n) !== undefined; },
      toObject: function () { var o = {}; for (var i = 0; i < res.headers.length; i++) o[res.headers[i][0].toLowerCase()] = resHeader(res.headers[i][0]); return o; },
      all: function () { return res.headers.map(function (h) { return { key: h[0], value: h[1] }; }); }
    });
    var cookiesApi = _freeze({
      get: resCookie,
      has: function (n) { return resCookie(n) !== undefined; },
      toObject: function () { var o = {}; for (var i = 0; i < res.cookies.length; i++) o[res.cookies[i].name] = res.cookies[i].value; return o; }
    });
    response = _freeze({
      status: res.status,
      statusText: res.statusText,
      code: res.status,
      time: res.timeMs,
      responseTime: res.timeMs,
      size: res.size,
      contentType: res.contentType,
      headers: resHeadersApi,
      cookies: cookiesApi,
      text: function () { return res.bodyText; },
      json: bodyJson
    });
  }

  // ---- tests ----
  function test(name, fn) {
    if (tests.length >= MAX_TESTS) throw new _Error('Too many tests');
    var entry = { name: _String(name === undefined ? 'Unnamed test' : name).slice(0, 500), passed: true };
    tests.push(entry);
    if (typeof fn !== 'function') { entry.passed = false; entry.message = 'Test callback must be a function'; return; }
    function onFail(e) { entry.passed = false; var d = describe(e); entry.message = d.message; if (d.line !== undefined) entry.line = d.line; }
    var r;
    try { r = fn(); } catch (e) { onFail(e); return; }
    if (r && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
      entry.pending = true;
      pending.push(new _Promise(function (resolve) {
        try {
          r.then(function () { entry.pending = false; resolve(); }, function (e) { entry.pending = false; onFail(e); resolve(); });
        } catch (e) { onFail(e); resolve(); }
      }));
    }
  }

  // ---- timers ----
  function clampMs(ms) { var n = _Number(ms); if (!(n > 0)) return 0; return n > MAX_SLEEP ? MAX_SLEEP : n; }
  function sleep(ms) {
    return new _Promise(function (resolve) { if (done) return; hostTimer(clampMs(ms), resolve); });
  }
  var timerSeq = 0;
  var timers = {};
  function setTimeoutFn(fn, ms) {
    if (typeof fn !== 'function') throw new _Error('setTimeout expects a function (string code is not allowed)');
    var id = ++timerSeq;
    var extra = Array.prototype.slice.call(arguments, 2);
    pending.push(new _Promise(function (resolve) {
      timers[id] = resolve;
      if (done) return resolve();
      hostTimer(clampMs(ms), function () {
        if (!timers[id]) return;
        delete timers[id];
        try { fn.apply(undefined, extra); } catch (e) { emit('error', [describe(e).message]); }
        resolve();
      });
    }));
    return id;
  }
  function clearTimeoutFn(id) { var r = timers[id]; if (r) { delete timers[id]; r(); } }

  // ---- console ----
  function emit(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(fmt(args[i], 0));
    var msg = parts.join(' ');
    if (msg.length > 10000) msg = msg.slice(0, 10000) + '... [truncated]';
    hostLog(level, msg);
  }
  function logger(level) { return function () { emit(level, Array.prototype.slice.call(arguments)); }; }
  var consoleApi = _freeze({
    log: logger('log'), info: logger('info'), warn: logger('warn'), error: logger('error'),
    debug: logger('log'), trace: logger('log'), dir: logger('log')
  });

  var info = _freeze({ phase: phase, eventName: phase === 'pre' ? 'prerequest' : 'test' });

  var reqvyn = _freeze({
    env: envApi,
    environment: envApi,
    variables: varApi,
    collectionVariables: collApi,
    globals: globApi,
    request: request,
    response: response,
    test: test,
    expect: function (actual) { return makeExpect(actual, false); },
    skipRequest: function () {
      if (phase !== 'pre') throw new _Error('reqvyn.skipRequest() can only be used in pre-request scripts');
      skip = true;
    },
    sleep: sleep,
    info: info
  });

  var pmRequest = {};
  _defineProperty(pmRequest, 'url', { enumerable: true, get: function () { return req.url; }, set: function (v) { request.url = v; } });
  _defineProperty(pmRequest, 'method', { enumerable: true, get: function () { return req.method; }, set: function (v) { request.method = v; } });
  _defineProperty(pmRequest, 'headers', { enumerable: true, value: reqHeaders });
  _defineProperty(pmRequest, 'body', { enumerable: true, get: function () { return req.body === undefined ? undefined : { mode: 'raw', raw: req.body, toString: function () { return req.body; } }; } });
  _freeze(pmRequest);

  var pmResponse;
  if (res) {
    pmResponse = {};
    var rkeys = _keys(response);
    for (var ri = 0; ri < rkeys.length; ri++) if (rkeys[ri] !== 'status') _defineProperty(pmResponse, rkeys[ri], { enumerable: true, value: response[rkeys[ri]] });
    _defineProperty(pmResponse, 'status', { enumerable: true, value: res.statusText });
    _defineProperty(pmResponse, 'responseSize', { enumerable: true, value: res.size });
    _defineProperty(pmResponse, 'to', { enumerable: false, get: function () { return chai(RESPONSE_MARK).to; } });
    _freeze(pmResponse);
  }

  var pm = _freeze({
    environment: envApi,
    variables: varApi,
    collectionVariables: collApi,
    globals: globApi,
    request: pmRequest,
    response: pmResponse,
    test: test,
    expect: function (actual) { return chai(actual === pmResponse && pmResponse ? RESPONSE_MARK : actual); },
    info: info
  });

  var g = globalThis;
  function defineGlobal(name, value) { _defineProperty(g, name, { value: value, writable: false, configurable: false, enumerable: false }); }
  defineGlobal('reqvyn', reqvyn);
  defineGlobal('pm', pm);
  defineGlobal('console', consoleApi);
  defineGlobal('btoa', toBase64);
  defineGlobal('atob', fromBase64);
  defineGlobal('setTimeout', setTimeoutFn);
  defineGlobal('clearTimeout', clearTimeoutFn);

  function finish(error) {
    if (done) return;
    function drain() {
      if (pending.length === 0) {
        done = true;
        var vc = [];
        for (var i = 0; i < changeOrder.length; i++) { var c = changes[changeOrder[i]]; vc.push({ scope: c.scope, key: c.key, value: c.value }); }
        var outTests = tests.map(function (t) {
          var o = { name: t.name, passed: t.passed && !t.pending };
          if (t.pending) o.message = 'Test did not complete';
          else if (t.message !== undefined) o.message = t.message;
          return o;
        });
        var result = { request: { method: req.method, url: req.url, headers: req.headers, body: req.body }, variableChanges: vc, tests: outTests, skipRequest: skip, durationMs: _now() - started };
        if (error) result.error = error;
        var json;
        try { json = _stringify(result); } catch (e) { json = _stringify({ error: { message: 'Could not serialise script result: ' + e.message } }); }
        hostDone(json);
        return;
      }
      var batch = pending.splice(0, pending.length);
      _Promise.all(batch).then(drain, drain);
    }
    drain();
  }

  if (compileError) { finish(compileError); return; }
  var p;
  try { p = userFn.call(undefined); } catch (e) { finish(describe(e)); return; }
  _Promise.resolve(p).then(function () { finish(undefined); }, function (e) { finish(describe(e)); });
};
})()`;
