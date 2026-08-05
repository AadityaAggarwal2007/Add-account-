// =============================================================
// DIRECT POSTGRESQL CONNECTION — Replaces @supabase/supabase-js
// Uses node-postgres (pg) with connection pooling.
// Queries run in 1-5ms on VPS (vs 50-150ms via Supabase cloud).
// =============================================================

import pkg from 'pg';
const { Pool } = pkg;

// Singleton pool — shared across all API route invocations
let _pool = null;

function getPool() {
  if (_pool) return _pool;

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    min: 2,          // Always keep 2 connections warm
    max: 20,         // Max connections (16GB RAM can handle this easily)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: false,      // Local PostgreSQL on VPS — no SSL needed
  });

  _pool.on('error', (err) => {
    console.error('[DB Pool] Unexpected error on idle client:', err.message);
  });

  return _pool;
}

/**
 * Run a parameterized query, return the full result object.
 * @param {string} sql - SQL query with $1, $2 placeholders
 * @param {any[]} [params] - Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(sql, params = []) {
  const pool = getPool();
  return pool.query(sql, params);
}

/**
 * Run a query and return all rows.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any[]>}
 */
export async function queryRows(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Run a query and return the first row (or null if none).
 * Equivalent to Supabase's .single()
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any|null>}
 */
export async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

/**
 * Run a query and return the count from a COUNT(*) query.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<number>}
 */
export async function queryCount(sql, params = []) {
  const result = await query(sql, params);
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Run multiple queries in a single transaction.
 * @param {function(client: import('pg').PoolClient): Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withTransaction(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
