// Open-Meteo — completely free, no API key required
// Pulls forecast for Newnan CC coordinates

const LAT = process.env.COURSE_LAT || '33.3807'
const LON = process.env.COURSE_LON || '-84.7997'

/**
 * Fetch weather forecast for a specific date
 * Returns { rainPct, lowTemp, highTemp } in Fahrenheit
 */
export async function getWeatherForDate(targetDate) {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', LAT)
  url.searchParams.set('longitude', LON)
  url.searchParams.set('daily', [
    'precipitation_probability_max',
    'temperature_2m_max',
    'temperature_2m_min'
  ].join(','))
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('timezone', 'America/New_York')
  url.searchParams.set('forecast_days', '10')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`)

  const data = await res.json()
  const { daily } = data

  // Find the index matching our target date
  const targetStr = targetDate.toISOString().split('T')[0]
  const idx = daily.time.findIndex(d => d === targetStr)

  if (idx === -1) {
    return { rainPct: null, lowTemp: null, highTemp: null }
  }

  return {
    rainPct: daily.precipitation_probability_max[idx],
    lowTemp: Math.round(daily.temperature_2m_min[idx]),
    highTemp: Math.round(daily.temperature_2m_max[idx])
  }
}

/**
 * Get weather for both Saturday and Sunday of a given week
 * weekOf = the Saturday Date object
 */
export async function getWeekendWeather(weekOf) {
  const saturday = new Date(weekOf)
  const sunday = new Date(weekOf)
  sunday.setDate(sunday.getDate() + 1)

  const [satWeather, sunWeather] = await Promise.all([
    getWeatherForDate(saturday),
    getWeatherForDate(sunday)
  ])

  return { saturday: satWeather, sunday: sunWeather }
}
