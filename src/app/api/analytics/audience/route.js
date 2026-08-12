import { NextResponse } from 'next/server';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

// GET /api/analytics/audience?account=UUID&from=&to=
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('account');
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');

  try {
    const accounts = accountId && accountId !== 'all'
      ? await queryRows(`SELECT * FROM meta_accounts WHERE id = $1 AND is_active = true`, [accountId])
      : await queryRows(`SELECT * FROM meta_accounts WHERE is_active = true`);

    if (!accounts.length) return NextResponse.json({ error: 'No accounts found' }, { status: 404 });

    const allAgeGender = {}, allCountry = {}, allDevice = {};

    const accountResults = await Promise.all(accounts.map(async (account) => {
      const [ageGenderData, countryData, deviceData] = await Promise.all([
        fetchBreakdown(account.meta_account_id, account.access_token, dateFrom, dateTo, 'age,gender').catch(() => []),
        fetchBreakdown(account.meta_account_id, account.access_token, dateFrom, dateTo, 'country').catch(() => []),
        fetchBreakdown(account.meta_account_id, account.access_token, dateFrom, dateTo, 'device_platform').catch(() => []),
      ]);
      return { ageGenderData, countryData, deviceData };
    }));

    for (const { ageGenderData, countryData, deviceData } of accountResults) {
      for (const row of ageGenderData) {
        const ageKey = row.age || 'Unknown';
        if (!allAgeGender[ageKey]) allAgeGender[ageKey] = { age: ageKey, spend: 0, clicks: 0, impressions: 0 };
        allAgeGender[ageKey].spend += parseFloat(row.spend || 0);
        allAgeGender[ageKey].clicks += parseInt(row.clicks || 0);
        allAgeGender[ageKey].impressions += parseInt(row.impressions || 0);
      }
      for (const row of countryData) {
        const key = row.country || 'Unknown';
        if (!allCountry[key]) allCountry[key] = { country: key, spend: 0, clicks: 0, impressions: 0, reach: 0 };
        allCountry[key].spend += parseFloat(row.spend || 0);
        allCountry[key].clicks += parseInt(row.clicks || 0);
        allCountry[key].impressions += parseInt(row.impressions || 0);
        allCountry[key].reach += parseInt(row.reach || 0);
      }
      for (const row of deviceData) {
        const key = row.device_platform || 'Unknown';
        if (!allDevice[key]) allDevice[key] = { device: key, spend: 0, clicks: 0, impressions: 0 };
        allDevice[key].spend += parseFloat(row.spend || 0);
        allDevice[key].clicks += parseInt(row.clicks || 0);
        allDevice[key].impressions += parseInt(row.impressions || 0);
      }
    }

    return NextResponse.json({
      ageGender: Object.values(allAgeGender).sort((a, b) => b.spend - a.spend),
      country: Object.values(allCountry).sort((a, b) => b.spend - a.spend).slice(0, 15),
      device: Object.values(allDevice).sort((a, b) => b.spend - a.spend),
    });
  } catch (err) {
    console.error('Audience breakdown error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function fetchBreakdown(accountId, accessToken, dateFrom, dateTo, breakdownType) {
  const fields = 'impressions,clicks,spend,reach,actions';
  const url = `${META_GRAPH_URL}/act_${accountId}/insights?` +
    `fields=${fields}` +
    `&breakdowns=${breakdownType}` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: dateFrom, until: dateTo }))}` +
    `&limit=500` +
    `&access_token=${accessToken}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Breakdown API failed: ${res.status}`);
  }
  const { data } = await res.json();
  return data || [];
}
