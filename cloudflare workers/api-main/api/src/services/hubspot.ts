declare const process: { env?: Record<string, string | undefined> } | undefined;

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

function resolveHubSpotAccessToken(accessToken?: string): string {
  const tokenFromProcess = typeof process !== 'undefined' ? process.env?.HUBSPOT_ACCESS_TOKEN : undefined;
  return (accessToken || tokenFromProcess || '').trim();
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

  return (await response.json()) as T;
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
): Promise<void> {
  const response = await fetch(existingContactId ? `${baseUrl}/${existingContactId}` : baseUrl, {
    method: existingContactId ? 'PATCH' : 'POST',
    headers: getHubSpotHeaders(hubspotToken),
    body: JSON.stringify({ properties }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hubspot_${response.status}:${detail}`);
  }
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
              value: customerPhone,
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
  const existingContact = searchData.results?.[0];

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
