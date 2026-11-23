// A fast reimplementation of makefun-site 1.0.0's build, written from its README spec
// (front matter, template dialect, Markdown subset, slug rule, report). No code is copied
// from the vendor implementation; the semantics were re-derived from the spec and are
// verified byte-for-byte against the reference on the practice set and on generated sites.
//
// run(input) returns the output tree: a JSON object of every path makefun-site writes
// and that file's text, byte for byte.

'use strict';

// --------------------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_ALL, (c) => ESC[c]) : text;
}

/** The escape of one character (used for a backslash escape's single character). */
function escCh(c) {
  const e = ESC[c];
  return e === undefined ? c : e;
}

/** Slug results, memoized: slugify is a pure function of its input, and titles and
 *  tag names repeat across a site. */
const slugCache = new Map();
const MARK_RE = /\p{M}/gu;
const TRAIL_DASH = /-+$/;

function slugify(text) {
  let r = slugCache.get(text);
  if (r !== undefined) return r;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(TRAIL_DASH, '');
  r = out === '' ? 'untitled' : out;
  slugCache.set(text, r);
  return r;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ------------------------------------------------------------------- whitespace

/** Whether code unit `c` is JavaScript whitespace (\s, BMP only; astral code points
 *  are never whitespace). */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

const isST = (c) => c === 32 || c === 9; // space or tab

/** A line with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isST(line.charCodeAt(a))) a++;
  while (b > a && isST(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A string with trailing spaces and tabs dropped. */
function trimRightST(s) {
  let b = s.length;
  while (b > 0 && isST(s.charCodeAt(b - 1))) b--;
  return b === s.length ? s : s.slice(0, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isST(line.charCodeAt(i))) return false;
  return true;
}

/** The words of a body: its runs of characters other than whitespace. ASCII letters
 *  and punctuation (the common case) take the fast path. */
function wordsOf(text) {
  let n = 0;
  let w = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c > 32 && c < 128 ? false : isWS(c);
    if (ws) w = false;
    else if (!w) {
      w = true;
      n++;
    }
  }
  return n;
}

// --------------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function hasBadTagChar(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return true;
  }
  return false;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || hasBadTagChar(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let i = 0;
      while (i < raw.length) {
        let j = i;
        while (j < raw.length) {
          const c = raw.charCodeAt(j);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
          else break;
        }
        if (j === i) return { error: 'key "slug": not a slug' };
        i = j;
        if (i === raw.length) break;
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
        if (i === raw.length) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Parsed by scanning line starts
 * with indexOf, so the body is never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  // The close line: a line exactly '---'. Search from the second line's start.
  let closeStart = -1;
  let closeEnd = -1;
  let s = 4;
  for (;;) {
    const idx = text.indexOf('---', s);
    if (idx === -1) return { error: 'the front matter is not closed' };
    if (text.charCodeAt(idx - 1) === 10 && (idx + 3 === text.length || text.charCodeAt(idx + 3) === 10)) {
      closeStart = idx;
      closeEnd = idx + 3 === text.length ? text.length : idx + 4;
      break;
    }
    s = idx + 1;
  }
  const data = {};
  let ln = 2; // the first front-matter line is line 2 (line 1 is the opening ---)
  let a = 4;
  while (a < closeStart) {
    let b = text.indexOf('\n', a);
    if (b === -1 || b > closeStart) b = closeStart;
    const line = text.slice(a, b);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: 'line ' + ln + ' is not "key: value"' };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: 'line ' + ln + ' is not "key: value"' };
      raw = trimRightST(raw);
      if (!KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    a = b + 1;
    ln++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd) };
}

// ------------------------------------------------------------------------- markdown

/** A fence opener's language, or null: ``` then a language, then spaces or tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let langEnd = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      i++;
      langEnd = i;
    } else break;
  }
  while (i < line.length && isST(line.charCodeAt(i))) i++;
  if (i !== line.length) return null;
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (!isST(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || !isST(line.charCodeAt(n))) return null;
  let a = n;
  while (a < line.length && isST(line.charCodeAt(a))) a++;
  let b = line.length;
  while (b > a && isST(line.charCodeAt(b - 1))) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) if (!isST(line.charCodeAt(i))) return false;
  return true;
}

/** A bullet item's text, or null: "- " or "* " then the rest. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null: 1-9 digits, ". ", then the rest. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/**
 * `src` rendered in one pass over its lines (no token array): its HTML (each block on
 * its own lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const blocks = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      let code = lang === '' ? '<pre><code>' : '<pre><code class="language-' + esc(lang) + '">';
      i++;
      while (i < lines.length && !fenceClose(lines[i])) {
        code += esc(lines[i]);
        code += '\n';
        i++;
      }
      i++;
      blocks.push(code + '</code></pre>');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const hhtml = inline(h.text, env);
      blocks.push('<h' + h.depth + ' id="' + id + '">' + hhtml + '</h' + h.depth + '>');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: hhtml });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(ls.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const start = isOrdered ? Number(o.num) : 1;
      const items = [];
      let parts = null;
      const flushItem = () => {
        if (parts !== null) {
          items.push('<li>' + inline(parts.join('\n'), env) + '</li>');
          parts = null;
        }
      };
      while (i < lines.length) {
        const li = lines[i];
        let rest = null;
        if (isOrdered) {
          const m = orderedOf(li);
          if (m !== null) rest = m.rest;
        } else {
          rest = bulletOf(li);
        }
        if (rest !== null) {
          flushItem();
          parts = [trimLine(rest)];
          i++;
          continue;
        }
        if (parts !== null && isContinued(li)) {
          parts.push(trimLine(li));
          i++;
          continue;
        }
        break;
      }
      flushItem();
      blocks.push((isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + (isOrdered ? 'ol' : 'ul') + '>') + '\n' + items.join('\n') + (items.length ? '\n' : '') + '</' + (isOrdered ? 'ol' : 'ul') + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const phtml = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = phtml;
    blocks.push('<p>' + phtml + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A match is escaped when an odd run of backslashes stands right before it (counted
 * from `from`, where the scan starts).
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let c = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) c++;
    if (c % 2 === 1) {
      j = k + 1;
      continue;
    }
    return k;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let c = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) c++;
    if (c % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j > i) {
      out += esc(s.slice(i, j));
      i = j;
    }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out += escCh(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', i + 1);
      if (m > i + 1) {
        out += '<code>';
        out += esc(s.slice(i + 1, m));
        out += '</code>';
        i = m + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const m = findUnescaped(s, '**', i + 2);
        if (m > i + 2) {
          out += '<strong>';
          out += inline(s.slice(i + 2, m), env);
          out += '</strong>';
          i = m + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const m = findSingleStar(s, i + 1);
      if (m > i + 1) {
        out += '<em>';
        out += inline(s.slice(i + 1, m), env);
        out += '</em>';
        i = m + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    const k2 = findUnescaped(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out += '<a href="';
      out += esc(env.link(target));
      out += '">';
      out += inline(s.slice(i + 1, k2), env);
      out += '</a>';
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}


// ------------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates
 * (`templates`, a Map of name to nodes), the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------- compiled templates
//
// A parsed template is compiled once into a function (S, D) => string, where S is
// the scope { vars, parent } and D the include depth. The generated code does the
// same lookups, truth tests and text conversions as renderNodes, but without walking
// the node tree on every render: text is pushed to an array and joined once, and a
// for-loop binds its scope in a block-scoped variable. If compilation ever fails,
// the build falls back to renderNodes for every template.

/** Lookups specialized by path length (paths in templates are 1-3 names). */
function lk1(s, a) {
  for (let sc = s; sc; sc = sc.parent) if (Object.hasOwn(sc.vars, a)) return sc.vars[a];
  return undefined;
}
function lk2(s, a, b) {
  for (let sc = s; sc; sc = sc.parent) {
    if (Object.hasOwn(sc.vars, a)) {
      const v = sc.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      return v[b];
    }
  }
  return undefined;
}
function lkN(s, p) {
  for (let sc = s; sc; sc = sc.parent) {
    if (Object.hasOwn(sc.vars, p[0])) {
      let v = sc.vars[p[0]];
      for (let k = 1; k < p.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[k])) return undefined;
        v = v[p[k]];
      }
      return v;
    }
  }
  return undefined;
}

// Fused value helpers: one call does the lookup and the conversion (and the escape
// for V), so a template variable costs one call instead of three.
function V1(s, a) {
  for (let sc = s; sc; sc = sc.parent) if (Object.hasOwn(sc.vars, a)) return esc(textOf(sc.vars[a]));
  return '';
}
function V2(s, a, b) {
  for (let sc = s; sc; sc = sc.parent) {
    if (Object.hasOwn(sc.vars, a)) {
      const v = sc.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
      return esc(textOf(v[b]));
    }
  }
  return '';
}
function VN(s, p) {
  return esc(textOf(lkN(s, p)));
}
function R1(s, a) {
  for (let sc = s; sc; sc = sc.parent) if (Object.hasOwn(sc.vars, a)) return textOf(sc.vars[a]);
  return '';
}
function R2(s, a, b) {
  for (let sc = s; sc; sc = sc.parent) {
    if (Object.hasOwn(sc.vars, a)) {
      const v = sc.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
      return textOf(v[b]);
    }
  }
  return '';
}
function RN(s, p) {
  return textOf(lkN(s, p));
}
function C1(s, a) {
  for (let sc = s; sc; sc = sc.parent) if (Object.hasOwn(sc.vars, a)) return truthy(sc.vars[a]);
  return false;
}
function C2(s, a, b) {
  for (let sc = s; sc; sc = sc.parent) {
    if (Object.hasOwn(sc.vars, a)) {
      const v = sc.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return false;
      return truthy(v[b]);
    }
  }
  return false;
}
function CN(s, p) {
  return truthy(lkN(s, p));
}

/** A lookup call for `path` in scope `sv`, by use: V escaped value, R raw value,
 *  C if-condition, L plain lookup (for a for-loop's array). */
function lkCall(path, sv, use) {
  const q = JSON.stringify;
  if (path.length === 1) return use + '1(' + sv + ',' + q(path[0]) + ')';
  if (path.length === 2) return use + '2(' + sv + ',' + q(path[0]) + ',' + q(path[1]) + ')';
  return use + 'N(' + sv + ',' + q(path) + ')';
}

/** `nodes` compiled to a function (S, D) => string; `tpls` is the map of compiled
 *  templates the includes resolve against at render time. */
function compileTemplate(nodes, tpls) {
  const lines = [];
  let counter = 0;
  const gen = (ns, sv) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          lines.push('O.push(' + JSON.stringify(n.text) + ');');
          break;
        case 'var':
          lines.push('O.push(' + lkCall(n.path, sv, 'V') + ');');
          break;
        case 'raw':
          lines.push('O.push(' + lkCall(n.path, sv, 'R') + ');');
          break;
        case 'if': {
          const test = n.not ? '!' + lkCall(n.path, sv, 'C') : lkCall(n.path, sv, 'C');
          lines.push('if (' + test + ') {');
          gen(n.then, sv);
          if (n.else !== null) {
            lines.push('} else {');
            gen(n.else, sv);
          }
          lines.push('}');
          break;
        }
        case 'for': {
          const id = ++counter;
          const sc = 'S' + id;
          // One vars object and one loop object per for-node, mutated per iteration:
          // rendering is synchronous and depth-first, so no render outlives its
          // iteration. The element binding is set before `loop`, as in the
          // reference's {[name]: x, loop: {...}} literal (so a loop variable named
          // "loop" still reads as the loop record).
          lines.push('{ const _a' + id + ' = ' + lkCall(n.path, sv, 'L') + '; if (Array.isArray(_a' + id + ')) { const _n' + id + ' = _a' + id + '.length; const _v' + id + ' = {}; const _l' + id + ' = { index: 0, first: false, last: false, length: _n' + id + ' }; const ' + sc + ' = { vars: _v' + id + ', parent: ' + sv + ' }; for (let _k' + id + ' = 0; _k' + id + ' < _n' + id + '; _k' + id + '++) { _v' + id + '[' + JSON.stringify(n.name) + '] = _a' + id + '[_k' + id + ']; _l' + id + '.index = _k' + id + ' + 1; _l' + id + '.first = _k' + id + ' === 0; _l' + id + '.last = _k' + id + ' === _n' + id + ' - 1; _v' + id + '.loop = _l' + id + ';');
          gen(n.body, sc);
          lines.push('} } }');
          break;
        }
        case 'include':
          lines.push('{ const _f = TP.get(' + JSON.stringify(n.name) + '); if (_f !== undefined && D < 8) O.push(_f(' + sv + ', D + 1)); }');
          break;
      }
    }
  };
  gen(nodes, 'S');
  const src = 'return function(S, D) { const O = [];\n' + lines.join('\n') + '\nreturn O.join(""); }';
  return new Function('V1', 'V2', 'VN', 'R1', 'R2', 'RN', 'C1', 'C2', 'CN', 'L1', 'L2', 'LN', 'TP', src)(V1, V2, VN, R1, R2, RN, C1, C2, CN, lk1, lk2, lkN, tpls);
}

// ---------------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: esc };
  const compiled = new Map();
  let useCompiled = true;
  for (const [name, nodes] of templates) {
    try {
      compiled.set(name, compileTemplate(nodes, compiled));
    } catch {
      useCompiled = false;
      break;
    }
  }
  const render = (name, vars) => {
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (useCompiled) {
      const fn = compiled.get(name);
      return fn === undefined ? null : fn(scope, 0);
    }
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, ctx, 0);
  };
  const output = {};
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
