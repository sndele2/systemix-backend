/**
 * lead-store.ts
 *
 * Persistence adapter for lead state.
 *
 * All reads and writes of Lead records and their sequence progress flow
 * through this module. The rest of the GTM module must never write lead
 * state directly — all mutations go through LeadStore.
 *
 * This is intentionally a thin adapter. The underlying storage backend
 * (Postgres, SQLite, Redis, etc.) is determined by the connection string
 * passed in from GTMConfig. Swap the implementation here without touching
 * any other file.
 *
 * Invariant: state must be persisted BEFORE any email is dispatched.
 * If persist fails, the send must not proceed.
 */

import type { Lead, LeadStatus } from './types';

// ---------------------------------------------------------------------------
// Persisted record (Lead + sequence tracking fields)
// ---------------------------------------------------------------------------

export interface LeadRecord {
  lead: Lead;
  status: LeadStatus;
  /** Number of email touches sent so far (0 = none yet). */
  touchesSent: number;
  /** Index of the last stage sent (undefined if none sent yet). */
  lastStageIndex?: 0 | 1 | 2;
  /** ISO-8601 timestamp of the last send attempt. */
  lastSentAt?: string;
  /** ISO-8601 timestamp when the sequence was stopped (if applicable). */
  stoppedAt?: string;
}

// ---------------------------------------------------------------------------
// LeadStore
// ---------------------------------------------------------------------------

export class LeadStore {
  private connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    // TODO: initialize database client here
  }

  /**
   * Persist a new lead record.
   * @throws if a record with the same lead.id already exists.
   */
  async create(record: LeadRecord): Promise<void> {
    // TODO: insert into backing store
    throw new Error('LeadStore.create: not implemented');
  }

  /**
   * Load a lead record by ID.
   * @returns null if no record exists for the given ID.
   */
  async findById(leadId: string): Promise<LeadRecord | null> {
    // TODO: query backing store by lead.id
    throw new Error('LeadStore.findById: not implemented');
  }

  /**
   * Update mutable fields on an existing record.
   * Performs a partial merge — only provided fields are overwritten.
   */
  async update(
    leadId: string,
    patch: Partial<Omit<LeadRecord, 'lead'>>,
  ): Promise<void> {
    // TODO: apply patch to existing record in backing store
    throw new Error('LeadStore.update: not implemented');
  }

  /**
   * Return all records currently in 'active' status.
   * Used by the sequence engine to find leads awaiting their next touch.
   */
  async findActive(): Promise<LeadRecord[]> {
    // TODO: query for records where status = 'active'
    throw new Error('LeadStore.findActive: not implemented');
  }
}
