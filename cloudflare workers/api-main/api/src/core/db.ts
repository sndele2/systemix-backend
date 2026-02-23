export async function getTenantName(db: D1Database, toPhone?: string | null): Promise<string | null> {
  if (!toPhone) return null;
  try {
    const tenantRes = await db.prepare(
      "SELECT company_name FROM tenants WHERE systemix_number = ? LIMIT 1"
    ).bind(toPhone).all();
    const tenantRow = tenantRes.results && tenantRes.results[0];
    return tenantRow?.company_name ? String(tenantRow.company_name) : null;
  } catch (e) {
    console.error('Tenant lookup failed:', e);
    return null;
  }
}

export async function getCallStatus(db: D1Database, callSid: string): Promise<string | null> {
  const statusRes = await db.prepare(
    "SELECT status FROM calls WHERE provider_call_id = ?"
  ).bind(callSid).all();
  const statusRow = statusRes.results && statusRes.results[0];
  return statusRow?.status ? String(statusRow.status) : null;
}
