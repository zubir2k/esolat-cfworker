/**
 * esolat-mcp â€” Cloudflare Worker Edition
 * MCP Streamable HTTP server for Malaysian prayer times, mosque finder, Islamic events
 * Compatible with M365 Copilot, Claude.ai, and any MCP Streamable HTTP client
 *
 * Port of: https://github.com/zubir2k/esolat-cfworker
 * Author: Muhammad Zubir Jamalullail
 */

export interface Env {
  MCP_WEBHOOK_TOKEN: string;
}

// â”€â”€â”€ Hijri Month Names â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const HIJRI_MONTHS: Record<string, string> = {
  "01": "Muharram",     "02": "Safar",          "03": "Rabi'ul Awwal",
  "04": "Rabi'ul Akhir","05": "Jamadil Awwal",  "06": "Jamadil Akhir",
  "07": "Rejab",        "08": "Sha'aban",        "09": "Ramadhan",
  "10": "Syawal",       "11": "Zulkaedah",       "12": "Zulhijjah",
};

// â”€â”€â”€ MCP Protocol Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// â”€â”€â”€ Tool Definitions (MCP schema) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TOOLS = [
  {
    name: "get_monthly_prayer_times",
    description:
      "Fetches the full monthly prayer schedule (Fajr, Syuruk, Dhuha, Dhuhr, Asr, Maghrib, Isha). " +
      "Accepts a place name OR latitude/longitude. Returns Gregorian + Hijri dates. " +
      "Dhuha is auto-computed (+28 minutes after Syuruk). Uses JAKIM/e-Solat for Malaysia, Aladhan API globally.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: {
          type: "string",
          description: "Place name e.g. 'Kuala Lumpur', 'Kajang', 'Johor Bahru'",
        },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        month: { type: "integer", description: "Month number 1â€“12 (default: current month)", minimum: 1, maximum: 12 },
        year: { type: "integer", description: "4-digit year (default: current year)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "find_nearest_mosques",
    description:
      "Finds up to 15 nearest mosques/masjids/suraus within a given radius. " +
      "Returns name, distance, coordinates, Google Maps link, and Waze deep link. " +
      "Malaysia uses official e-Solat/JAKIM data; elsewhere uses OpenStreetMap Overpass API.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Place name to search from" },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        distance_km: {
          type: "integer",
          description: "Search radius in km (default: 5)",
          minimum: 1, maximum: 50,
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_yearly_islamic_events",
    description:
      "Returns major Islamic calendar events and public holidays for a given year. " +
      "Malaysia routing uses official JAKIM e-Solat data. Falls back to Aladhan API globally.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Place name for Malaysia/global routing" },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        target_year: {
          type: "integer",
          description: "4-digit year (default: 2026)",
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// â”€â”€â”€ Geo Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isMalaysia(lat: number, lon: number): boolean {
  return lat >= 1.0 && lat <= 7.5 && lon >= 99.5 && lon <= 119.5;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

// â”€â”€â”€ Location Resolver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function resolveLocation(
  locationName?: string,
  latitude?: number,
  longitude?: number
): Promise<[number, number]> {
  if (latitude !== undefined && longitude !== undefined) {
    return [latitude, longitude];
  }
  if (locationName) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "esolat-mcp-cf/1.0 (Cloudflare Worker)" },
    });
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) throw new Error(`Location '${locationName}' could not be resolved.`);
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  }
  throw new Error("Provide either location_name or latitude/longitude coordinates.");
}

// â”€â”€â”€ Epoch â†’ HH:MM (UTC+8) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function epochToMY(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// â”€â”€â”€ Date Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function dayName(year: number, month: number, day: number): string {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return days[new Date(year, month - 1, day).getDay()];
}

function hijriLabel(hm: string, monthMap: Record<string, string>) {
  return monthMap[hm] ?? hm;
}

// â”€â”€â”€ Tool Implementations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function toolGetPrayerTimes(args: Record<string, unknown>): Promise<unknown> {
  const [lat, lon] = await resolveLocation(
    args.location_name as string | undefined,
    args.latitude as number | undefined,
    args.longitude as number | undefined
  );

  const now = new Date();
  const month = (args.month as number) ?? now.getMonth() + 1;
  const year = (args.year as number) ?? now.getFullYear();
  const prayers: unknown[] = [];

  if (isMalaysia(lat, lon)) {
    const url = `https://api.waktusolat.app/v2/solat/gps/${lat}/${lon}?year=${year}&month=${month}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to reach Malaysian prayer API (waktusolat.app).");
    const data = (await res.json()) as { prayers: Array<Record<string, unknown>> };

    for (const d of data.prayers ?? []) {
      const day = d.day as number;
      const syurukTs = d.syuruk as number;
      const dhuhaTs = syurukTs + 28 * 60;
      const hijriRaw = d.hijri as string;
      const [hY, hM, hD] = hijriRaw.split("-");
      prayers.push({
        date: `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`,
        day_name: dayName(year, month, day),
        hijri_raw: hijriRaw,
        hijri_full: `${parseInt(hD)} ${hijriLabel(hM, HIJRI_MONTHS)} ${hY}`,
        fajr:    epochToMY(d.fajr as number),
        syuruk:  epochToMY(syurukTs),
        dhuha:   epochToMY(dhuhaTs),
        dhuhr:   epochToMY(d.dhuhr as number),
        asr:     epochToMY(d.asr as number),
        maghrib: epochToMY(d.maghrib as number),
        isha:    epochToMY(d.isha as number),
      });
    }
  } else {
    const url = `https://api.aladhan.com/v1/calendar?latitude=${lat}&longitude=${lon}&method=2&month=${month}&year=${year}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to reach Aladhan global prayer API.");
    const data = (await res.json()) as { data: Array<Record<string, unknown>> };

    for (const d of data.data ?? []) {
      const timings = d.timings as Record<string, string>;
      const gregDate = (d.date as Record<string, unknown>).gregorian as Record<string, unknown>;
      const rawDate = gregDate.date as string; // "DD-MM-YYYY"
      const [dd, mm, yyyy] = rawDate.split("-");
      const parsedGreg = `${yyyy}-${mm}-${dd}`;

      const syurukStr = (timings.Sunrise ?? "").split(" ")[0];
      const [sH, sM] = syurukStr.split(":").map(Number);
      const dhuhaMin = sM + 28;
      const dhuhaStr = `${String(sH + Math.floor(dhuhaMin / 60)).padStart(2,"0")}:${String(dhuhaMin % 60).padStart(2,"0")}`;

      const hijriMeta = (d.date as Record<string, unknown>).hijri as Record<string, unknown>;
      const hMonthNum = String((hijriMeta.month as Record<string, unknown>).number).padStart(2,"0");
      const hDay = hijriMeta.day as string;
      const hYear = hijriMeta.year as string;

      prayers.push({
        date: parsedGreg,
        day_name: ((gregDate.weekday as Record<string, unknown>).en as string),
        hijri_raw: `${hYear}-${hMonthNum}-${String(hDay).padStart(2,"0")}`,
        hijri_full: `${parseInt(hDay)} ${hijriLabel(hMonthNum, HIJRI_MONTHS)} ${hYear}`,
        fajr:    (timings.Fajr ?? "").split(" ")[0],
        syuruk:  syurukStr,
        dhuha:   dhuhaStr,
        dhuhr:   (timings.Dhuhr ?? "").split(" ")[0],
        asr:     (timings.Asr ?? "").split(" ")[0],
        maghrib: (timings.Maghrib ?? "").split(" ")[0],
        isha:    (timings.Isha ?? "").split(" ")[0],
      });
    }
  }

  return prayers;
}

async function toolFindMosques(args: Record<string, unknown>): Promise<unknown> {
  const [lat, lon] = await resolveLocation(
    args.location_name as string | undefined,
    args.latitude as number | undefined,
    args.longitude as number | undefined
  );
  const distKm = (args.distance_km as number) ?? 5;
  const mosques: unknown[] = [];

  if (isMalaysia(lat, lon)) {
    const url = `https://www.e-solat.gov.my/index.php?r=esolatApi/nearestMosque&lat=${lat}&long=${lon}&dist=${distKm}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { locationData?: Array<Record<string, unknown>> };
      for (const item of data.locationData ?? []) {
        const mLat = parseFloat(item.latitud as string);
        const mLon = parseFloat(item.longitud as string);
        mosques.push({
          name: (item.nama_masjid as string).trim(),
          distance_km: Math.round(parseFloat(item.distance as string) * 100) / 100,
          coordinates: { latitude: mLat, longitude: mLon },
          google_maps_link: `https://maps.google.com/?q=${mLat},${mLon}`,
          waze_link: `https://waze.com/ul?ll=${mLat},${mLon}&navigate=yes&z=10`,
        });
      }
    }
  } else {
    const radiusM = distKm * 1000;
    const query = `[out:json][timeout:25];(node["amenity"="place_of_worship"]["religion"="muslim"](around:${radiusM},${lat},${lon});way["amenity"="place_of_worship"]["religion"="muslim"](around:${radiusM},${lat},${lon}););out body center;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      headers: { "User-Agent": "esolat-mcp-cf/1.0" },
    });
    if (res.ok) {
      const data = (await res.json()) as { elements: Array<Record<string, unknown>> };
      for (const el of data.elements ?? []) {
        const mLat = (el.lat ?? (el.center as Record<string, unknown>)?.lat) as number | undefined;
        const mLon = (el.lon ?? (el.center as Record<string, unknown>)?.lon) as number | undefined;
        if (mLat == null || mLon == null) continue;
        const tags = (el.tags ?? {}) as Record<string, string>;
        const name = tags.name ?? tags.official_name ?? "Mosque / Muslim Place of Worship";
        mosques.push({
          name: name.trim(),
          distance_km: haversine(lat, lon, mLat, mLon),
          coordinates: { latitude: mLat, longitude: mLon },
          google_maps_link: `https://maps.google.com/?q=${mLat},${mLon}`,
          waze_link: `https://waze.com/ul?ll=${mLat},${mLon}&navigate=yes&z=10`,
        });
      }
      (mosques as Array<{ distance_km: number }>).sort((a, b) => a.distance_km - b.distance_km);
    }
  }

  return mosques.slice(0, 15);
}

async function toolGetIslamicEvents(args: Record<string, unknown>): Promise<unknown> {
  let localRoute = true;
  try {
    const [lat, lon] = await resolveLocation(
      args.location_name as string | undefined,
      args.latitude as number | undefined,
      args.longitude as number | undefined
    );
    localRoute = isMalaysia(lat, lon);
  } catch {
    localRoute = true;
  }

  const targetYear = (args.target_year as number) ?? new Date().getFullYear();
  const events: unknown[] = [];

  if (localRoute) {
    const url = "https://www.e-solat.gov.my/index.php?r=esolatApi/islamicevent&type=all";
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { event?: Array<Record<string, unknown>> };
      for (const item of data.event ?? []) {
        const gregDate = item.tarikh_miladi as string;
        if (gregDate?.startsWith(String(targetYear))) {
          events.push({
            event_name: (item.hari_peristiwa as string).replace(/\*/g, "").trim(),
            gregorian_date: gregDate,
            hijri_date: item.tarikh_hijri,
          });
        }
      }
    }
  } else {
    const url = `https://api.aladhan.com/v1/islamicEvents?year=${targetYear}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      for (const item of data.data ?? []) {
        const rawDate = item.gregorianDate as string; // "DD-MM-YYYY"
        const [dd, mm, yyyy] = rawDate.split("-");
        events.push({
          event_name: ((item.arahName as string)?.trim() || (item.label as string)?.trim()),
          gregorian_date: `${yyyy}-${mm}-${dd}`,
          hijri_date: `${item.hijriYear}-${String(item.hijriMonth).padStart(2,"0")}-${String(item.hijriDay).padStart(2,"0")}`,
        });
      }
    }
  }

  (events as Array<{ gregorian_date: string }>).sort((a, b) =>
    a.gregorian_date.localeCompare(b.gregorian_date)
  );
  return events;
}

// â”€â”€â”€ MCP Request Router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleMCP(req: MCPRequest): Promise<MCPResponse> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "esolat-mcp", version: "2.0.0" },
          },
        };

      case "notifications/initialized":
        // No-op notification â€” no response needed, but return empty result to be safe
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: args = {} } = (req.params ?? {}) as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        let result: unknown;
        switch (name) {
          case "get_monthly_prayer_times":
            result = await toolGetPrayerTimes(args);
            break;
          case "find_nearest_mosques":
            result = await toolFindMosques(args);
            break;
          case "get_yearly_islamic_events":
            result = await toolGetIslamicEvents(args);
            break;
          default:
            return {
              jsonrpc: "2.0", id,
              error: { code: -32601, message: `Unknown tool: ${name}` },
            };
        }

        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0", id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0", id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : "Internal server error",
      },
    };
  }
}

// â”€â”€â”€ Health Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function checkUpstream(url: string, method = "GET"): Promise<string> {
  try {
    const opts: RequestInit = method === "POST"
      ? { method: "POST", body: new URLSearchParams({ data: "[out:json][timeout:2];out;" }) }
      : { method: "GET" };
    const res = await fetch(url, {
      ...opts,
      headers: { "User-Agent": "esolat-mcp-cf/2.0 (https://github.com/zubir2k/esolat-cfworker)" },
      signal: AbortSignal.timeout(4000),
    });
    return [200, 400, 404].includes(res.status) ? "CONNECTED" : "DEGRADED";
  } catch {
    return "UNREACHABLE";
  }
}

async function healthDashboard(): Promise<Response> {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const [jakim, waktu, osm] = await Promise.all([
    checkUpstream("https://www.e-solat.gov.my/index.php?r=esolatApi/islamicevent&type=all"),
    checkUpstream(`https://api.waktusolat.app/v2/solat/gps/3.02/101.79?year=${year}&month=${month}`),
    checkUpstream("https://nominatim.openstreetmap.org/search?q=Kajang&format=json&limit=1"),
  ]);

  return Response.json({
    server: "esolat-mcp",
    edition: "Cloudflare Worker",
    status: "ONLINE",
    version: "2.0.0",
    timestamp: now.toISOString(),
    upstream_apis: {
      jakim_e_solat: jakim,
      waktu_solat_app: waktu,
      openstreetmap_nominatim: osm,
    },
  });
}

// â”€â”€â”€ Main Fetch Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!env.MCP_WEBHOOK_TOKEN) {
      return new Response(
        "Server misconfigured: MCP_WEBHOOK_TOKEN secret is not set.\n" +
        "Run: wrangler secret put MCP_WEBHOOK_TOKEN",
        { status: 500 }
      );
    }
    const token = env.MCP_WEBHOOK_TOKEN;
    const expectedPrefix = `/mcp/${token}`;

	// Root landing page
	if (path === "/" || path === "") {
	  return new Response(
		`esolat-mcp (Cloudflare Worker) is running!\n\n` +
		`Health dashboard:  ${url.origin}/mcp/<TOKEN>/health\n` +
		`MCP endpoint:      ${url.origin}/mcp/<TOKEN>/mcp\n\n` +
		`Replace <TOKEN> with your MCP_WEBHOOK_TOKEN secret.`,
		{ headers: { "Content-Type": "text/plain" } }
	  );
	}

    // Reject paths outside the token scope
    if (!path.startsWith(expectedPrefix)) {
      return Response.json(
        { error: "Unauthorized: invalid or missing webhook token path." },
        { status: 401 }
      );
    }

    const subPath = path.slice(expectedPrefix.length) || "/";

    // â”€â”€ Health dashboard (/health) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (subPath === "/health" || subPath === "/health/") {
      return await healthDashboard();
    }

    // â”€â”€ MCP Streamable HTTP endpoint (/mcp) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (subPath === "/mcp" || subPath === "/mcp/" || subPath === "/") {
      // OPTIONS pre-flight (for M365 Copilot CORS)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
          },
        });
      }

      // GET â€” some clients probe the endpoint
      if (request.method === "GET") {
        return Response.json({
          jsonrpc: "2.0",
          result: { server: "esolat-mcp", transport: "streamable-http" },
        });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      let body: MCPRequest | MCPRequest[];
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400 }
        );
      }

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };

      // Batch support
      if (Array.isArray(body)) {
        const responses = await Promise.all(body.map(handleMCP));
        return new Response(JSON.stringify(responses), { headers: corsHeaders });
      }

      // Skip response for notifications (no id)
      if (body.method?.startsWith("notifications/")) {
        await handleMCP(body); // fire-and-forget side-effects if any
        return new Response(null, { status: 202, headers: corsHeaders });
      }

      const response = await handleMCP(body);
      return new Response(JSON.stringify(response), { headers: corsHeaders });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

