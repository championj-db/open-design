// SQLite-flavoured statement text -> PostgreSQL statement text.
//
// The stores were written against better-sqlite3, so their statements use
// `?` / `@name` placeholders and lean on a few SQLite semantics that differ in
// Postgres. Statements that need a real rewrite (upserts, JSON functions,
// GROUP BY strictness) were ported by hand; this module covers the mechanical,
// whole-statement rules so the remaining SQL text stays readable and
// identical in intent:
//
//   - `?`, `?NNN`, `@name`, `:name`, `$name` placeholders -> `$1..$n`. Every
//     occurrence gets its own `$n`, so one named value used in two contexts
//     never forces a single inferred type on both.
//   - `? IS [NOT] NULL` -> `$n::text IS [NOT] NULL` (Postgres cannot infer the
//     type of a parameter that is only null-tested).
//   - ORDER BY terms get explicit NULL placement matching SQLite (NULL sorts
//     lowest: first ascending, last descending) unless they already say NULLS.
//   - LIKE -> ILIKE (SQLite's LIKE is ASCII case-insensitive).
//   - CAST(x AS INTEGER|REAL) -> BIGINT / DOUBLE PRECISION (SQLite widths).
//   - mixed-case identifiers (`AS projectId`) are quoted so Postgres keeps
//     their case the way SQLite does.
//   - two-or-more-argument MAX()/MIN() keep SQLite's scalar semantics,
//     including NULL if any argument is NULL (not GREATEST/LEAST).
//   - IFNULL( -> COALESCE(, `==` -> `=`, `backtick` identifiers -> "double".
//
// Text inside string literals, quoted identifiers and comments is untouched.

export interface TranslatedSql {
  text: string;
  /** For each `$n` (index n-1): positional index into the args, or a named key. */
  bindings: Array<number | string>;
  /** True when the source already used `$1`-style placeholders. */
  native: boolean;
}

type TokenKind = 'ws' | 'comment' | 'string' | 'quoted' | 'word' | 'number' | 'param' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  /** For params: positional index or named key. */
  binding?: number | string;
}

const ORDER_TERMINATORS = new Set([
  'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING',
  'ROWS', 'RANGE', 'GROUPS', 'WINDOW', 'ON', 'DO', 'WHERE', 'SET', 'VALUES', 'SELECT',
]);

function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function tokenize(sql: string): { tokens: Token[]; native: boolean } {
  const tokens: Token[] = [];
  let native = false;
  let positional = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? '';
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j]!)) j++;
      tokens.push({ kind: 'ws', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '-' && next === '-') {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      tokens.push({ kind: 'comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      tokens.push({ kind: 'comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const body = sql.slice(i, Math.min(j + 1, n));
      if (ch === '`') {
        const inner = body.slice(1, -1).replace(/``/g, '`').replace(/"/g, '""');
        tokens.push({ kind: 'quoted', text: `"${inner}"` });
      } else {
        tokens.push({ kind: ch === "'" ? 'string' : 'quoted', text: body });
      }
      i = j + 1;
      continue;
    }
    if (ch === '?') {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      if (j > i + 1) {
        tokens.push({ kind: 'param', text: '?', binding: Number(sql.slice(i + 1, j)) - 1 });
      } else {
        tokens.push({ kind: 'param', text: '?', binding: positional++ });
      }
      i = j;
      continue;
    }
    if (ch === '$') {
      // Dollar-quoted string: $$...$$ or $tag$...$tag$.
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const j = close < 0 ? n : close + tag[0].length;
        tokens.push({ kind: 'string', text: sql.slice(i, j) });
        i = j;
        continue;
      }
    }
    if ((ch === '@' || ch === '$' || ch === ':') && isWordStart(next)) {
      const prev = sql[i - 1] ?? '';
      if (!(ch === ':' && prev === ':') && !isWordChar(prev)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
        tokens.push({ kind: 'param', text: sql.slice(i, j), binding: sql.slice(i + 1, j) });
        i = j;
        continue;
      }
    }
    if (ch === '$' && /[0-9]/.test(next)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      native = true;
      tokens.push({ kind: 'punct', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!)) j++;
      tokens.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j]!)) j++;
      tokens.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '=' && next === '=') {
      tokens.push({ kind: 'punct', text: '=' });
      i += 2;
      continue;
    }
    if (ch === ':' && next === ':') {
      tokens.push({ kind: 'punct', text: '::' });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', text: ch });
    i += 1;
  }
  return { tokens, native };
}

function upper(token: Token | undefined): string {
  return token && token.kind === 'word' ? token.text.toUpperCase() : '';
}

function lastSignificant(tokens: Token[]): Token | undefined {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const token = tokens[k]!;
    if (token.kind !== 'ws' && token.kind !== 'comment') return token;
  }
  return undefined;
}

/** True when tokens[index] is a call `name(a, b, ...)` with 2+ arguments. */
function hasTopLevelComma(tokens: Token[], index: number): boolean {
  let k = index + 1;
  while (k < tokens.length && (tokens[k]!.kind === 'ws' || tokens[k]!.kind === 'comment')) k++;
  if (tokens[k]?.text !== '(') return false;
  let depth = 0;
  for (; k < tokens.length; k++) {
    const text = tokens[k]!.text;
    if (tokens[k]!.kind !== 'punct') continue;
    if (text === '(') depth++;
    else if (text === ')') {
      depth--;
      if (depth === 0) return false;
    } else if (text === ',' && depth === 1) return true;
  }
  return false;
}

interface OrderClause {
  depth: number;
  itemStart: number;
}

export function translateSql(sql: string): TranslatedSql {
  const { tokens, native } = tokenize(sql);
  const significant: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'ws' && token.kind !== 'comment') significant.push(index);
  });
  const nextSig = (index: number, offset: number): Token | undefined => {
    const pos = significant.indexOf(index);
    const target = significant[pos + offset];
    return target === undefined ? undefined : tokens[target];
  };

  const out: Token[] = [];
  const bindings: Array<number | string> = [];
  const orders: OrderClause[] = [];
  // Depths (inside the parens) of multi-argument MAX/MIN calls being rewritten.
  const scalarFrames: number[] = [];
  let scalarPending = false;
  let depth = 0;

  // Finish the ORDER BY item spanning out[clause.itemStart..end).
  const finishItem = (clause: OrderClause, end: number) => {
    let itemDepth = 0;
    let lastSig = -1;
    let lastWordAtDepth = '';
    let hasNulls = false;
    for (let k = clause.itemStart; k < end; k++) {
      const token = out[k]!;
      if (token.kind === 'ws' || token.kind === 'comment') continue;
      lastSig = k;
      if (token.text === '(') itemDepth++;
      else if (token.text === ')') itemDepth--;
      if (itemDepth === 0) {
        const word = upper(token);
        lastWordAtDepth = word || (token.text === ')' ? '' : lastWordAtDepth);
        if (word === 'NULLS') hasNulls = true;
      }
    }
    if (lastSig < 0 || hasNulls) return;
    const suffix = lastWordAtDepth === 'DESC' ? ' NULLS LAST' : ' NULLS FIRST';
    out.splice(lastSig + 1, 0, { kind: 'ws', text: suffix });
  };

  const closeOrders = (atDepth: number) => {
    while (orders.length > 0 && orders[orders.length - 1]!.depth >= atDepth) {
      finishItem(orders.pop()!, out.length);
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const word = upper(token);
    const current = orders[orders.length - 1];

    if (
      token.kind === 'punct' && token.text === ','
      && scalarFrames.length > 0 && scalarFrames[scalarFrames.length - 1] === depth
    ) {
      out.push({ kind: 'ws', text: '), (' });
      continue;
    }

    if (current && current.depth === depth) {
      if (token.text === ';' || (word && ORDER_TERMINATORS.has(word))) {
        closeOrders(depth);
      } else if (token.kind === 'punct' && token.text === ',') {
        finishItem(current, out.length);
        out.push(token);
        current.itemStart = out.length;
        continue;
      }
    }

    if (token.kind === 'punct' && token.text === '(') {
      depth++;
      out.push(token);
      if (scalarPending) {
        scalarFrames.push(depth);
        scalarPending = false;
      }
      continue;
    }
    if (token.kind === 'punct' && token.text === ')') {
      closeOrders(depth);
      out.push(token);
      if (scalarFrames.length > 0 && scalarFrames[scalarFrames.length - 1] === depth) {
        scalarFrames.pop();
        out.push({ kind: 'ws', text: ') AS od_scalar(od_v))' });
      }
      depth--;
      continue;
    }

    if (word === 'ORDER' && upper(nextSig(index, 1)) === 'BY') {
      const byIndex = significant[significant.indexOf(index) + 1]!;
      for (let k = index; k <= byIndex; k++) out.push(tokens[k]!);
      index = byIndex;
      orders.push({ depth, itemStart: out.length });
      continue;
    }

    if (token.kind === 'param' && !native) {
      bindings.push(token.binding!);
      let text = `$${bindings.length}`;
      const following = nextSig(index, 1);
      if (upper(following) === 'IS') {
        const after = upper(nextSig(index, 2));
        const after2 = upper(nextSig(index, 3));
        if (after === 'NULL' || (after === 'NOT' && after2 === 'NULL')) text += '::text';
      }
      out.push({ kind: 'punct', text });
      continue;
    }

    if (token.kind === 'word' && /[a-z]/.test(token.text) && /[A-Z]/.test(token.text)) {
      // SQLite keeps identifier case; Postgres folds unquoted names to lower
      // case, which would turn `AS projectId` into a `projectid` row key.
      out.push({ kind: 'quoted', text: `"${token.text}"` });
      continue;
    }
    // CAST(x AS INTEGER) must not narrow epoch-ms values to int4, and SQLite's
    // REAL is a double.
    if ((word === 'INTEGER' || word === 'REAL') && upper(lastSignificant(out)) === 'AS') {
      out.push({ kind: 'word', text: word === 'INTEGER' ? 'BIGINT' : 'DOUBLE PRECISION' });
      continue;
    }
    if (word === 'LIKE') {
      out.push({ kind: 'word', text: 'ILIKE' });
      continue;
    }
    if ((word === 'MAX' || word === 'MIN') && hasTopLevelComma(tokens, index)) {
      // SQLite's multi-argument max()/min() are scalar functions that return
      // NULL when ANY argument is NULL; GREATEST/LEAST would skip NULLs. Fold
      // the arguments as rows instead, each argument appearing exactly once
      // (so placeholders keep one binding each):
      //   (SELECT CASE WHEN bool_or(od_v IS NULL) THEN NULL ELSE max(od_v) END
      //      FROM (VALUES (a), (b)) AS od_scalar(od_v))
      out.push({
        kind: 'ws',
        text: `(SELECT CASE WHEN bool_or(od_v IS NULL) THEN NULL ELSE ${word}(od_v) END FROM (VALUES `,
      });
      scalarPending = true;
      continue;
    }
    if (word === 'IFNULL' && nextSig(index, 1)?.text === '(') {
      out.push({ kind: 'word', text: 'COALESCE' });
      continue;
    }
    out.push(token);
  }
  closeOrders(0);

  return { text: out.map((token) => token.text).join(''), bindings, native };
}
