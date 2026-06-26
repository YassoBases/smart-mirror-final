// Weather / time / season context for a profile.
//
// Uses OpenWeatherMap (OWM_API_KEY) for the profile's location. Profiles carry
// no coordinates (see docs/wardrobe/00_backend_findings.md §7), so location
// falls back to HOME_LAT / HOME_LNG env, documented in .env.example. If neither
// the API key nor coordinates are available, returns time/season only (computed
// locally) with null temperature/weather.

const OWM_API_KEY = process.env.OWM_API_KEY || "";

// Season from latitude + month. Northern hemisphere mapping, flipped for south.
function seasonFor(lat, date = new Date()) {
  const m = date.getMonth() + 1;
  let s;
  if (m === 12 || m <= 2) s = "winter";
  else if (m <= 5) s = "spring";
  else if (m <= 8) s = "summer";
  else s = "autumn";
  if (typeof lat === "number" && lat < 0) {
    s = { winter: "summer", summer: "winter", spring: "autumn", autumn: "spring" }[s];
  }
  return s;
}

function timeOfDayFor(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

function resolveLocation() {
  const lat = process.env.HOME_LAT ? Number(process.env.HOME_LAT) : null;
  const lng = process.env.HOME_LNG ? Number(process.env.HOME_LNG) : null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

/**
 * @returns {Promise<{temperature:number|null, weather:string|null, timeOfDay:string, season:string}>}
 */
async function getContext() {
  const now = new Date();
  const loc = resolveLocation();
  const lat = loc ? loc.lat : null;

  const base = {
    temperature: null,
    weather: null,
    timeOfDay: timeOfDayFor(now),
    season: seasonFor(lat, now),
  };

  if (!OWM_API_KEY || !loc) return base;

  try {
    const url =
      `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${loc.lat}&lon=${loc.lng}&units=metric&appid=${OWM_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return base;
    const data = await res.json();
    return {
      temperature: typeof data?.main?.temp === "number" ? data.main.temp : null,
      weather: data?.weather?.[0]?.main || null,
      timeOfDay: base.timeOfDay,
      season: base.season,
    };
  } catch (err) {
    console.warn("[context] OWM fetch failed:", err.message);
    return base;
  }
}

module.exports = { getContext, seasonFor, timeOfDayFor };
