import { Router } from 'express'
import supabase from '../supabase.js'
import { requireAdmin } from '../middleware/auth.js'
import { getWeekendWeather } from '../services/weather.js'

const router = Router()

// All admin routes require admin auth
router.use(requireAdmin)

// ─── GET /admin/players ──────────────────────────────────────
router.get('/players', async (req, res) => {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .order('name')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ─── POST /admin/players ─────────────────────────────────────
router.post('/players', async (req, res) => {
  const { name, email, phone, handicap_index } = req.body
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' })

  const { data, error } = await supabase
    .from('players')
    .insert({ name, email: email.toLowerCase().trim(), phone, handicap_index })
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

// ─── PUT /admin/players/:id ──────────────────────────────────
router.put('/players/:id', async (req, res) => {
  const { name, email, phone, handicap_index, is_active } = req.body

  const { data, error } = await supabase
    .from('players')
    .update({ name, email, phone, handicap_index, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

// ─── DELETE /admin/players/:id ───────────────────────────────
// Soft delete — set is_active = false
router.delete('/players/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('players')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json({ message: 'Player deactivated', player: data })
})

// ─── GET /admin/weeks ────────────────────────────────────────
router.get('/weeks', async (req, res) => {
  const { data, error } = await supabase
    .from('weeks')
    .select('*')
    .order('week_of', { ascending: false })
    .limit(10)

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ─── POST /admin/weeks ───────────────────────────────────────
// Manually create a week (also done automatically by cron)
router.post('/weeks', async (req, res) => {
  const { week_of } = req.body
  if (!week_of) return res.status(400).json({ error: 'week_of (YYYY-MM-DD Saturday date) required' })

  // Pull weather immediately
  const weekDate = new Date(week_of + 'T12:00:00')
  const weather = await getWeekendWeather(weekDate).catch(() => ({ saturday: {}, sunday: {} }))

  const { data, error } = await supabase
    .from('weeks')
    .insert({
      week_of,
      saturday_rain_pct: weather.saturday.rainPct,
      saturday_low_temp: weather.saturday.lowTemp,
      saturday_high_temp: weather.saturday.highTemp,
      sunday_rain_pct: weather.sunday.rainPct,
      sunday_low_temp: weather.sunday.lowTemp,
      sunday_high_temp: weather.sunday.highTemp,
      weather_updated_at: new Date().toISOString()
    })
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

// ─── POST /admin/weeks/:id/lock ──────────────────────────────
router.post('/weeks/:id/lock', async (req, res) => {
  const { day } = req.body // 'saturday' | 'sunday' | 'both'
  const updates = {}
  if (day === 'saturday' || day === 'both') updates.saturday_locked = true
  if (day === 'sunday' || day === 'both') updates.sunday_locked = true

  const { data, error } = await supabase
    .from('weeks')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

// ─── GET /admin/roster/:week_id ──────────────────────────────
// Full roster view with non-respondents
router.get('/roster/:week_id', async (req, res) => {
  const { week_id } = req.params

  const [{ data: week }, { data: allPlayers }, { data: signups }] = await Promise.all([
    supabase.from('weeks').select('*').eq('id', week_id).single(),
    supabase.from('players').select('*').eq('is_active', true).order('name'),
    supabase.from('signups').select('*, player:players(id, name, email, handicap_index)').eq('week_id', week_id)
  ])

  if (!week) return res.status(404).json({ error: 'Week not found' })

  const signupMap = {}
  signups.forEach(s => { signupMap[s.player_id] = s })

  // Categorize every player
  const satConfirmed = [], satWaitlist = [], satOut = [], satNoResponse = []
  const sunConfirmed = [], sunWaitlist = [], sunOut = [], sunNoResponse = []

  allPlayers.forEach(p => {
    const s = signupMap[p.id]
    if (!s) {
      satNoResponse.push(p)
      sunNoResponse.push(p)
      return
    }
    if (s.saturday_status === 'confirmed') satConfirmed.push(p)
    else if (s.saturday_status === 'waitlist') satWaitlist.push(p)
    else satOut.push(p)

    if (s.sunday_status === 'confirmed') sunConfirmed.push(p)
    else if (s.sunday_status === 'waitlist') sunWaitlist.push(p)
    else sunOut.push(p)
  })

  res.json({
    week,
    saturday: {
      confirmed: satConfirmed,
      waitlist: satWaitlist,
      out: satOut,
      no_response: satNoResponse,
      spots_remaining: Math.max(0, week.saturday_max - satConfirmed.length)
    },
    sunday: {
      confirmed: sunConfirmed,
      waitlist: sunWaitlist,
      out: sunOut,
      no_response: sunNoResponse,
      spots_remaining: Math.max(0, week.sunday_max - sunConfirmed.length)
    }
  })
})

// ─── POST /admin/weeks/:id/refresh-weather ───────────────────
router.post('/weeks/:id/refresh-weather', async (req, res) => {
  const { data: week } = await supabase.from('weeks').select('*').eq('id', req.params.id).single()
  if (!week) return res.status(404).json({ error: 'Week not found' })

  const weekDate = new Date(week.week_of + 'T12:00:00')
  const weather = await getWeekendWeather(weekDate)

  const { data } = await supabase.from('weeks').update({
    saturday_rain_pct: weather.saturday.rainPct,
    saturday_low_temp: weather.saturday.lowTemp,
    saturday_high_temp: weather.saturday.highTemp,
    sunday_rain_pct: weather.sunday.rainPct,
    sunday_low_temp: weather.sunday.lowTemp,
    sunday_high_temp: weather.sunday.highTemp,
    weather_updated_at: new Date().toISOString()
  }).eq('id', req.params.id).select().single()

  res.json(data)
})

export default router
