import type { AntColonySimulation } from './colony';

/**
 * Ties the colony to the player's real surroundings: their local clock (sunrise / sunset) and the live
 * weather where they are. Location comes from the browser's geolocation; if that is refused or unavailable
 * an approximate city-level location is looked up from the network address. Weather is Open-Meteo (free,
 * no key). Everything is cached so the next start (or an offline start) begins from the last known sky.
 */

export type WeatherCondition = 'Clear' | 'Cloudy' | 'Fog' | 'Drizzle' | 'Rain' | 'Heavy Rain' | 'Thunderstorm' | 'Snow';

export interface LiveWeather {
  condition: WeatherCondition;
  tempC: number;
  /** 0..1 */
  humidity: number;
  rainMmH: number;
  snowCmH: number;
  /** 0..1 */
  cloud: number;
  windKmh: number;
  /** direction the wind blows FROM, degrees (meteorological) */
  windDir: number;
  /** epoch ms */
  sunrise: number;
  sunset: number;
  latitude: number;
  fetchedAt: number;
}

const LOC_KEY = 'antz_location_v1';
const WX_KEY = 'antz_weather_v1';
const REFRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

/** WMO weather interpretation codes -> the handful of conditions the colony cares about. */
export function conditionFromCode(code: number, rainMmH: number, snowCmH: number): WeatherCondition {
  if (code >= 95) return 'Thunderstorm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86 || snowCmH > 0.05) return 'Snow';
  if (code === 65 || code === 82 || code === 67 || rainMmH >= 4) return 'Heavy Rain';
  if ((code >= 61 && code <= 64) || code === 80 || code === 81 || code === 66 || rainMmH >= 0.6) return 'Rain';
  if ((code >= 51 && code <= 57) || rainMmH > 0) return 'Drizzle';
  if (code === 45 || code === 48) return 'Fog';
  if (code === 3 || code === 2) return 'Cloudy';
  return 'Clear';
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: fine, we just refetch next time */
  }
}

async function fetchJson(url: string, timeoutMs = 9000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function browserLocation(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(e),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60 * 60 * 1000 }
    );
  });
}

async function ipLocation(): Promise<{ lat: number; lon: number }> {
  try {
    const j = await fetchJson('https://get.geojs.io/v1/ip/geo.json');
    const lat = parseFloat(j.latitude);
    const lon = parseFloat(j.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  } catch {
    /* try the next provider */
  }
  const j = await fetchJson('https://ipapi.co/json/');
  const lat = Number(j.latitude);
  const lon = Number(j.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('no ip location');
  return { lat, lon };
}

export async function fetchLiveWeather(lat: number, lon: number): Promise<LiveWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&current=temperature_2m,relative_humidity_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' +
    '&daily=sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=2';
  const j = await fetchJson(url);
  const c = j.current ?? {};
  const rain = (Number(c.rain) || 0) + (Number(c.showers) || 0) || Number(c.precipitation) || 0;
  const snow = Number(c.snowfall) || 0;
  const code = Number(c.weather_code) || 0;
  // pick today's sunrise/sunset (the pair that brackets now, or today's if we're before/after)
  const rises: number[] = (j.daily?.sunrise ?? []).map((s: number) => s * 1000);
  const sets: number[] = (j.daily?.sunset ?? []).map((s: number) => s * 1000);
  const now = Date.now();
  let sunrise = rises[0] ?? now - 6 * 3600e3;
  let sunset = sets[0] ?? now + 6 * 3600e3;
  if (now > sunset && rises[1] && sets[1]) {
    // after today's sunset the next relevant event is tomorrow's sunrise; keep today's pair (night is handled by clock math)
    sunrise = rises[0];
    sunset = sets[0];
  }
  return {
    condition: conditionFromCode(code, rain, snow),
    tempC: Number(c.temperature_2m) || 0,
    humidity: (Number(c.relative_humidity_2m) || 60) / 100,
    rainMmH: rain,
    snowCmH: snow,
    cloud: (Number(c.cloud_cover) || 0) / 100,
    windKmh: Number(c.wind_speed_10m) || 0,
    windDir: Number(c.wind_direction_10m) || 270,
    sunrise,
    sunset,
    latitude: lat,
    fetchedAt: now,
  };
}

export class RealWorld {
  private readonly sim: AntColonySimulation;
  private timer = 0;
  private stopped = false;
  private loc: { lat: number; lon: number } | null = null;

  constructor(sim: AntColonySimulation) {
    this.sim = sim;
  }

  public start(): void {
    // start from the last known sky immediately, even offline
    const cached = readJson<LiveWeather>(WX_KEY);
    if (cached && Date.now() - cached.fetchedAt < 12 * 3600e3) this.sim.applyLiveWeather(cached, true);
    void this.refresh();
  }

  public stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
  }

  private async locate(): Promise<{ lat: number; lon: number }> {
    if (this.loc) return this.loc;
    const cached = readJson<{ lat: number; lon: number; at: number }>(LOC_KEY);
    try {
      this.loc = await browserLocation();
    } catch {
      try {
        this.loc = await ipLocation();
      } catch (e) {
        if (cached) this.loc = { lat: cached.lat, lon: cached.lon };
        else throw e;
      }
    }
    writeJson(LOC_KEY, { ...this.loc, at: Date.now() });
    return this.loc;
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    let next = REFRESH_MS;
    try {
      const { lat, lon } = await this.locate();
      const wx = await fetchLiveWeather(lat, lon);
      if (this.stopped) return;
      writeJson(WX_KEY, wx);
      this.sim.applyLiveWeather(wx, false);
    } catch {
      // no location or no network: the colony keeps its own simulated weather until we get through
      next = RETRY_MS;
    }
    if (!this.stopped) this.timer = window.setTimeout(() => void this.refresh(), next);
  }
}
