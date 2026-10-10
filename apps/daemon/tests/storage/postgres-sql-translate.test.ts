import { describe, expect, it } from 'vitest';
import { translateSql } from '../../src/storage/postgres/sql-translate.js';

describe('translateSql', () => {
  it('numbers positional placeholders and records their bindings', () => {
    expect(translateSql('SELECT * FROM t WHERE a = ? AND b = ?')).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2',
      bindings: [0, 1],
      native: false,
    });
  });

  it('gives every named occurrence its own $n', () => {
    const out = translateSql('UPDATE t SET a = @a, b = :b WHERE id = $id AND a <> @a');
    expect(out.text).toBe('UPDATE t SET a = $1, b = $2 WHERE id = $3 AND a <> $4');
    expect(out.bindings).toEqual(['a', 'b', 'id', 'a']);
  });

  it('leaves native $n placeholders, casts, and literals alone', () => {
    const out = translateSql(`SELECT x::text, '?' AS q, "Mixed?" FROM t WHERE id = $1 -- ? comment`);
    expect(out.native).toBe(true);
    expect(out.text).toBe(`SELECT x::text, '?' AS q, "Mixed?" FROM t WHERE id = $1 -- ? comment`);
  });

  it('casts null-tested parameters so Postgres can type them', () => {
    expect(translateSql('SELECT 1 WHERE (? IS NULL OR a = ?) AND ? IS NOT NULL').text)
      .toBe('SELECT 1 WHERE ($1::text IS NULL OR a = $2) AND $3::text IS NOT NULL');
  });

  it('quotes mixed-case aliases so row keys keep their case', () => {
    expect(translateSql('SELECT project_id AS projectId, t.createdAt FROM t').text)
      .toBe('SELECT project_id AS "projectId", t."createdAt" FROM t');
  });

  it('adds SQLite NULL ordering to ORDER BY terms', () => {
    expect(translateSql('SELECT * FROM t ORDER BY a, b DESC, c ASC LIMIT 5').text)
      .toBe('SELECT * FROM t ORDER BY a NULLS FIRST, b DESC NULLS LAST, c ASC NULLS FIRST LIMIT 5');
    expect(translateSql('SELECT row_number() OVER (PARTITION BY a ORDER BY b DESC) FROM t').text)
      .toBe('SELECT row_number() OVER (PARTITION BY a ORDER BY b DESC NULLS LAST) FROM t');
    expect(translateSql('SELECT * FROM t ORDER BY a DESC NULLS FIRST').text)
      .toBe('SELECT * FROM t ORDER BY a DESC NULLS FIRST');
    expect(translateSql('SELECT * FROM t ORDER BY CASE WHEN a THEN 1 ELSE 2 END, max(b) DESC').text)
      .toBe('SELECT * FROM t ORDER BY CASE WHEN a THEN 1 ELSE 2 END NULLS FIRST, max(b) DESC NULLS LAST');
  });

  it('maps SQLite functions and operators', () => {
    expect(translateSql('SELECT IFNULL(a, 0), MAX(c) FROM t WHERE a == 1').text)
      .toBe('SELECT COALESCE(a, 0), MAX(c) FROM t WHERE a = 1');
    expect(translateSql("SELECT CAST(a AS INTEGER), CAST(b AS REAL) FROM t WHERE c LIKE '%x%'").text)
      .toBe("SELECT CAST(a AS BIGINT), CAST(b AS DOUBLE PRECISION) FROM t WHERE c ILIKE '%x%'");
  });

  it('rewrites scalar MAX/MIN with SQLite NULL semantics, one binding per argument', () => {
    const out = translateSql('SELECT MAX(a, ?) AS hi, MIN(b, c, ?) FROM t ORDER BY MAX(x, y) DESC');
    expect(out.text).toBe(
      'SELECT (SELECT CASE WHEN bool_or(od_v IS NULL) THEN NULL ELSE MAX(od_v) END FROM (VALUES (a), ( $1)) AS od_scalar(od_v)) AS hi, '
        + '(SELECT CASE WHEN bool_or(od_v IS NULL) THEN NULL ELSE MIN(od_v) END FROM (VALUES (b), ( c), ( $2)) AS od_scalar(od_v)) FROM t '
        + 'ORDER BY (SELECT CASE WHEN bool_or(od_v IS NULL) THEN NULL ELSE MAX(od_v) END FROM (VALUES (x), ( y)) AS od_scalar(od_v)) DESC NULLS LAST',
    );
    expect(out.bindings).toEqual([0, 1]);
  });

  it('treats dollar-quoted bodies and backtick identifiers correctly', () => {
    expect(translateSql('CREATE FUNCTION f() RETURNS int AS $body$ SELECT ? $body$ LANGUAGE sql').text)
      .toBe('CREATE FUNCTION f() RETURNS int AS $body$ SELECT ? $body$ LANGUAGE sql');
    expect(translateSql('SELECT `weird name` FROM t').text).toBe('SELECT "weird name" FROM t');
  });
});
