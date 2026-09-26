// Static checks on the browser client.
//
// The client has no DOM harness here — its rendering and animation are eyeballed
// rather than tested. But two classes of defect are visible by reading the
// source alone, both of which fail silently in a browser rather than throwing,
// and both of which actually shipped before these tests existed:
//
//   1. Looking up a shared constant by its NAME instead of its VALUE, so the
//      lookup misses and the user sees a generic fallback message.
//   2. Querying a DOM id that is not in the markup, which returns null and
//      throws only when the element is first touched.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BOT_VERSIONS } from '../server/bots.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');

const jsFiles = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const sources = new Map(jsFiles.map((f) => [f, readFileSync(path.join(JS_DIR, f), 'utf8')]));
const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

/* ── error text lookups ────────────────────────────────────────────────────── */

test('the client never looks up error text by constant name', () => {
  // `ERR_TEXT` is keyed by values ('no_such_room'), but `ERR` is keyed by names
  // (NO_SUCH_ROOM). Passing the name compiles, runs, and silently falls through
  // to the generic "malformed request" message — which is how an empty room code
  // came to say "That request was malformed." instead of the room-is-gone text.
  const calls = [];

  for (const [file, source] of sources) {
    // showError('NAME_INVALID') / errText('NO_SUCH_ROOM') — an all-caps literal
    // in an argument position is the signature of this bug.
    for (const m of source.matchAll(/\b(showError|errText)\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      calls.push(`${file}: ${m[1]}('${m[2]}')`);
    }
  }

  assert.deepEqual(calls, [], `pass ERR.X, not the literal name:\n  ${calls.join('\n  ')}`);
});

test('ERR_TEXT covers every code the client can be handed', () => {
  // Driven off ERR, not off ERR_TEXT. Iterating ERR_TEXT only proves that the
  // entries which exist are well-formed — adding `ERR.NOT_PLAYABLE` without its
  // message would sail straight through here and surface to the player as the
  // generic "something went wrong on the server".
  const missing = Object.entries(ERR)
    .filter(([, value]) => typeof ERR_TEXT[value] !== 'string' || ERR_TEXT[value].length === 0)
    .map(([name, value]) => `${name} ('${value}')`);

  assert.deepEqual(missing, [], `ERR entries with no ERR_TEXT: ${missing.join(', ')}`);

  for (const [name, value] of Object.entries(ERR_TEXT)) {
    assert.equal(typeof value, 'string', `ERR_TEXT.${name} is not a string`);
    assert.ok(value.length > 0, `ERR_TEXT.${name} is empty`);
  }

  // And the fallback the client relies on must exist.
  assert.ok(ERR_TEXT.server_error, 'the client fallback message must exist');
  assert.ok(ERR_TEXT.no_such_room, 'looking up by value must find the room message');
  assert.ok(ERR_TEXT.name_invalid, 'looking up by value must find the name message');
});

/* ── DOM ids ───────────────────────────────────────────────────────────────── */

test('every element id the client queries exists in the markup', () => {
  const ids = new Set();

  for (const [, source] of sources) {
    // Both the direct call and the module-local `$` alias, which is defined as
    // `(id) => document.getElementById(id)` in ui.js and lobby.js.
    for (const pattern of [/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g, /\$\('([^']+)'\)/g]) {
      for (const m of source.matchAll(pattern)) ids.add(m[1]);
    }
  }

  const missing = [...ids].filter((id) => !new RegExp(`id=["']${id}["']`).test(html));

  assert.deepEqual(missing, [], `queried but not present in index.html: ${missing.join(', ')}`);
  assert.ok(ids.size > 20, `expected the client to query many ids, found ${ids.size}`);
});

/**
 * Any string, single-, double- or backtick-quoted.
 *
 * Written as three explicit alternatives rather than a backreference so the
 * pattern can be embedded twice in one regex. Backticks are matched as a plain
 * run of non-backticks, which is what lets `dot${on ? '' : ' off'}` — quotes and
 * all — come through as one literal.
 */
const STR = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`)`;

const strip = (m) => m.slice(1, -1);

/**
 * Names of functions in a source that put a class on an element on their
 * caller's behalf.
 *
 * `pulse(cell, 'captured', 1100)` never says `classList` at the call site, so a
 * scan that only looks for `classList.x('literal')` sees nothing — and every
 * class routed through such a helper silently drops out of this test. That is
 * not hypothetical: it is exactly how `.captured`, `.attacking` and
 * `.target-hit` all came to be unchecked at once.
 *
 * The body is found by brace matching rather than a regex, because a nested
 * function or object literal would otherwise end the match early.
 */
function classHelpers(source) {
  const names = [];

  for (const m of source.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
    }
    if (source.slice(m.index, i).includes('classList')) names.push(m[1]);
  }

  return names;
}

/**
 * Every class name the client can put on an element, with its file.
 *
 * A class that no rule styles is invisible, and there are four spellings that
 * put one on an element — `classList.add('x')`, an alias of it (`const cl =
 * cell.poly.classList`), the `el(tag, className)` helper, and
 * `setAttribute('class', …)`. The first version of this test matched only the
 * first, so the board's own `territory`, `badge` and `void` were never checked.
 *
 * Interpolations are stripped before the text is split, so `toast ${kind}`
 * yields `toast`. A class written *only* inside an interpolation is still not
 * seen — that is the `' off'` in `dot${connected ? '' : ' off'}` — but those sit
 * beside a literal class in the same expression, which is the part being
 * checked. Anything the scanner cannot reach, it does not claim to cover.
 */
function classesUsed() {
  const found = new Map();

  const record = (text, file) => {
    for (const token of text.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/i.test(token)) found.set(token, file);
    }
  };

  for (const [file, source] of sources) {
    // Whatever this file calls `classList`: matching the literal name alone
    // misses `cl.add('void')`, which is how every board class is applied.
    const aliases = [...source.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*[\w$.]*\.classList\b/g)];
    const receiver = ['classList', ...aliases.map((m) => m[1])].join('|');

    // Every literal in a call's argument list, not just the first: the board
    // clears four classes in one `cl.remove('mine', 'selected', …)`, and taking
    // only the leading literal left the other three unchecked.
    const argumentsOf = (text) => [...text.matchAll(new RegExp(STR, 'g'))].map((m) => strip(m[0]));

    const callArgs = new RegExp(
      String.raw`\b(?:${receiver})\s*\.\s*(?:add|toggle|remove)\s*\(((?:${STR}|[^)])*)\)`,
      'g',
    );
    // The `el(tag, className, text)` helper in ui.js and lobby.js — only the
    // second argument is a class; the third is the element's text.
    const elClass = new RegExp(String.raw`\bel\(\s*(?:${STR})\s*,\s*(${STR})`, 'g');
    const attrClass = new RegExp(String.raw`setAttribute\(\s*'class'\s*,\s*(${STR})`, 'g');

    for (const m of source.matchAll(callArgs)) {
      for (const literal of argumentsOf(m[1])) record(literal, file);
    }
    for (const pattern of [elClass, attrClass]) {
      for (const m of source.matchAll(pattern)) record(strip(m[1]), file);
    }

    // And the classes those helpers are handed at their call sites, which is
    // where the name actually appears.
    for (const name of classHelpers(source)) {
      for (const m of source.matchAll(new RegExp(String.raw`\b${name}\s*\(([^)]*)\)`, 'g'))) {
        for (const literal of argumentsOf(m[1])) record(literal, file);
      }
    }
  }

  return found;
}

test('every class the client uses has a rule in the stylesheet', () => {
  // A class with no CSS is invisible: the roll log's player name rendered
  // unstyled because `.log .who` was never defined, and the board's water would
  // have been indistinguishable from an unowned province without `.void`.
  const css = readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
  const used = classesUsed();
  const missing = [...used].filter(([cls]) => !css.includes(`.${cls}`)).map(([cls, file]) => `${cls} (${file})`);

  assert.deepEqual(missing, [], `classes used but never styled: ${missing.join(', ')}`);
  // A floor on the scanner itself, not on the client: the previous version of
  // this test found only four classes and passed, because its pattern matched a
  // spelling the client barely uses. Fewer than 30 means the extraction has
  // regressed, and a passing result would mean nothing.
  assert.ok(used.size >= 30, `the scanner found only ${used.size} classes; it has stopped seeing the client`);
});

/* ── the add-bot buttons ───────────────────────────────────────────────────── */

test('the add-bot buttons offer exactly the versions the server accepts', () => {
  // The buttons and the registry are two lists that have to agree, and the
  // delegated listener means neither the id check above nor anything else can
  // see the second one: `data-bot-version` is read with `closest()`, so a button
  // naming a version that does not exist is a button that looks right, is styled
  // right, and answers "That bot version doesn't exist." to every click.
  //
  // Both directions are failures worth catching. A new policy with no button is
  // unreachable from the lobby. A stale button outlives its policy and is a
  // control that can only ever produce an error.
  const offered = [...html.matchAll(/data-bot-version="([^"]*)"/g)].map((m) => m[1]);

  // The empty string is the Random button, which sends no version at all and is
  // the absence of a choice rather than a fourth policy.
  assert.deepEqual(
    offered.filter((v) => v !== ''),
    BOT_VERSIONS.map(String),
    'the buttons and BOT_VERSIONS have drifted apart',
  );
  assert.ok(offered.includes(''), 'the Random button is gone, so there is no way to ask for a random bot');

  // And the three parts of the handoff, each of which can be edited alone: the
  // markup above, the delegated read in the lobby, and the payload in main.
  const lobby = sources.get('lobby.js');
  assert.match(lobby, /closest\('button\[data-bot-version\]'\)/, 'the lobby button selector moved');
  assert.match(lobby, /dataset\.botVersion/, 'the lobby stopped reading the version off the button');
  assert.match(
    sources.get('main.js'),
    /version \? \{ version: Number\(version\) \} : \{\}/,
    'main.js stopped turning the button attribute into an ADD_BOT payload',
  );
});
