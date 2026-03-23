type HubSpotApiResult<T> = {
  id?: string;
  results?: T[];
};

type HubSpotContact = {
  id: string;
};

type CreateCompanyInput = {
  companyName: string;
  phone?: string;
  accessToken?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
};

type UpsertContactInput = {
  phone: string;
  accessToken?: string;
  properties?: Record<string, string | undefined>;
};

function resolveHubSpotAccessToken(accessToken?: string): string {
  return (accessToken || '').trim();
}

function getHubSpotHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

async function hubspotRequest<T>(path: string, init: RequestInit, accessToken: string): Promise<T> {
  const response = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      ...getHubSpotHeaders(accessToken),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hubspot_${response.status}:${detail}`);
  }

  const body = await response.text();
  return (body ? (JSON.parse(body) as T) : undefined) as T;
}

function isMissingPropertyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('property') &&
    (normalized.includes("doesn't exist") ||
      normalized.includes('does not exist') ||
      normalized.includes('property_doesnt_exist'))
  );
}

async function saveContact(
  baseUrl: string,
  existingContactId: string | undefined,
  properties: Record<string, string>,
  hubspotToken: string
): Promise<string> {
  const response = await fetch(existingContactId ? `${baseUrl}/${existingContactId}` : baseUrl, {
    method: existingContactId ? 'PATCH' : 'POST',
    headers: getHubSpotHeaders(hubspotToken),
    body: JSON.stringify({ properties }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hubspot_${response.status}:${detail}`);
  }

  const body = await response.text();
  const result = body ? ((JSON.parse(body) as HubSpotApiResult<unknown>) || {}) : {};
  const savedContactId = existingContactId || result.id;

  if (!savedContactId) {
    throw new Error('hubspot_contact_save_missing_id');
  }

  return String(savedContactId);
}

function normalizeProperties(
  properties: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, string] => {
      const value = entry[1];
      return typeof value === 'string' && value.trim().length > 0;
    })
  );
}

async function findContactByPhone(phone: string, hubspotToken: string): Promise<HubSpotContact | undefined> {
  const baseUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
  const searchRes = await fetch(`${baseUrl}/search`, {
    method: 'POST',
    headers: getHubSpotHeaders(hubspotToken),
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'phone',
              operator: 'EQ',
              value: phone,
            },
          ],
        },
      ],
    }),
  });

  if (!searchRes.ok) {
    const detail = await searchRes.text();
    throw new Error(`hubspot_${searchRes.status}:${detail}`);
  }

  const searchData = (await searchRes.json()) as HubSpotApiResult<HubSpotContact>;
  return searchData.results?.[0];
}

export async function upsertHubSpotContactByPhone(input: UpsertContactInput): Promise<string> {
  const hubspotToken = resolveHubSpotAccessToken(input.accessToken);
  if (!hubspotToken) {
    throw new Error('missing_hubspot_access_token');
  }

  const baseUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
  const phone = input.phone.trim();
  if (!phone) {
    throw new Error('missing_hubspot_contact_phone');
  }

  const existingContact = await findContactByPhone(phone, hubspotToken);
  const properties = normalizeProperties({
    phone,
    ...(input.properties || {}),
  });

  return saveContact(baseUrl, existingContact?.id, properties, hubspotToken);
}

export async function syncToHubspot(
  customerPhone: string,
  classification: string,
  gptSummary: string,
  env: any
): Promise<void> {
  const hubspotToken = resolveHubSpotAccessToken(env?.HUBSPOT_ACCESS_TOKEN);
  if (!hubspotToken) {
    throw new Error('missing_hubspot_access_token');
  }

  const baseUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
  const existingContact = await findContactByPhone(customerPhone, hubspotToken);

  const properties = {
    phone: customerPhone,
    systemix_lead_type: classification.charAt(0).toUpperCase() + classification.slice(1),
    systemix_ai_summary: gptSummary,
  };

  try {
    await saveContact(baseUrl, existingContact?.id, properties, hubspotToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isMissingPropertyError(message)) {
      throw error instanceof Error ? error : new Error(message);
    }

    await saveContact(
      baseUrl,
      existingContact?.id,
      {
        phone: customerPhone,
        message: `[${classification.toUpperCase()}] ${gptSummary}`,
      },
      hubspotToken
    );
  }
}

export async function associateContactToCompany(
  contactId: string,
  companyId: string,
  accessToken?: string
): Promise<void> {
  const hubspotToken = resolveHubSpotAccessToken(accessToken);
  if (!hubspotToken) {
    throw new Error('missing_hubspot_access_token');
  }

  await hubspotRequest<void>(
    `/crm/v4/objects/0-1/${encodeURIComponent(contactId)}/associations/default/0-2/${encodeURIComponent(companyId)}`,
    {
      method: 'PUT',
    },
    hubspotToken
  );
}

export async function createHubSpotCompany(input: CreateCompanyInput): Promise<string> {
  const accessToken = resolveHubSpotAccessToken(input.accessToken);
  if (!accessToken) {
    throw new Error('missing_hubspot_access_token');
  }

  const descriptionParts = [
    input.stripeCustomerId ? `stripe_customer_id: ${input.stripeCustomerId}` : '',
    input.stripeSubscriptionId ? `stripe_subscription_id: ${input.stripeSubscriptionId}` : '',
  ].filter(Boolean);

  const payload = {
    properties: {
      name: input.companyName,
      phone: input.phone || undefined,
      description: descriptionParts.length ? descriptionParts.join(' | ') : undefined,
    },
  };

  const result = await hubspotRequest<HubSpotApiResult<unknown>>(
    '/crm/v3/objects/companies',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    accessToken
  );

  if (!result.id) {
    throw new Error('hubspot_company_create_missing_id');
  }

  return String(result.id);
}

export async function deleteHubSpotCompany(companyId: string, accessToken?: string): Promise<void> {
  const hubspotToken = resolveHubSpotAccessToken(accessToken);
  if (!hubspotToken) {
    throw new Error('missing_hubspot_access_token');
  }

  await hubspotRequest<void>(
    `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`,
    {
      method: 'DELETE',
    },
    hubspotToken
  );
}
