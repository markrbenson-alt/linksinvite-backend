import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import supabase from '../supabase.js'
import { requireAuth } from '../middleware/auth.js'
import { sendWaitlistOpening } from '../services/email.js'

const router = Router()

// ─── GET /roster/week/current ────────────────────────────────
// Returns current week + full roster for both days
router.get('/week/current', async (req, res) => {
  const today = new Date()
  const dayOfWeek = today.getDay() // 0=Sun, 1=Mon...6=Sat

  // Find next Saturday
  const daysUntilSat = (6 - dayOfWeek + 7) % 7 || 7
  const nextSat = new Date(today)
  nextSat.setDate(today.getDate() + daysUntilSat)
  const satStr = nextSat.toISOString().split('T')[0]

  const { data: week, error } = await supabase
    .from('weeks')
    .select('*')
    .eq('week_of', satStr)
    .single()

  if (error || !week) {
    return res.status(404).json({ error: 'No active week found' })
  }

  const { data: signups } = await supabase
    .from('signups')
    .select('*, player:players(id, name, handicap_index)')
    .eq('week_id', week.id)

  const satConfirmed = signups.filter(s => s.saturday_status === 'confirmed')
    .sort((a, b) => new Date(a.saturday_signed_up_at) - new Date(b.saturday_signed_up_at))
  const satWaitlist = signups.filter(s => s.saturday_status === 'waitlist')
    .sort((a, b) => new Date(a.saturday_signed_up_at) - new Date(b.saturday_signed_up_at))
  const sunConfirmed = signups.filter(s => s.sunday_status === 'confirmed')
    .sort((a, b) => new Date(a.sunday_signed_up_at) - new Date(b.sunday_signed_up_at))
  const sunWaitlist = signups.filter(s => s.sunday_status === 'waitlist')
    .sort((a, b) => new Date(a.sunday_signed_up_at) - new Date(b.sunday_signed_up_at))

  res.json({
    week,
    saturday: {
      confirmed: satConfirmed.map(s => s.player),
      waitlist: satWaitlist.map(s => s.player),
      spots_remaining: Math.max(0, week.saturday_max - satConfirmed.length),
      is_full: satConfirmed.length >= week.saturday_max,
      is_locked: week.saturday_locked
    },
    sunday: {
      confirmed: sunConfirmed.map(s => s.player),
      waitlist: sunWaitlist.map(s => s.player),
      spots_remaining: Math.max(0, week.sunday_max - sunConfirmed.length),
      is_full: sunConfirmed.length >= week.sunday_max,
      is_locked: week.sunday_locked
    }
  })
})

// ─── POST /roster/signup ─────────────────────────────────────
// Player signs up for saturday, sunday, or both
router.post('/signup', requireAuth, async (req, res) => {
  const { week_id, saturday, sunday } = req.body
  const playerId = req.player.id

  if (!week_id) return res.status(400).json({ error: 'week_id required' })
  if (!saturday && !sunday) return res.status(400).json({ error: 'Select at least one day' })

  const { data: week } = await supabase.from('weeks').select('*').eq('id', week_id).single()
  if (!week) return res.status(404).json({ error: 'Week not found' })

  // Get current counts
  const { data: signups } = await supabase.from('signups').select('*').eq('week_id', week_id)
  const satCount = signups.filter(s => s.saturday_status === 'confirmed').length
  const sunCount = signups.filter(s => s.sunday_status === 'confirmed').length

  // Get or create this player's signup record
  let { data: existing } = await supabase
    .from('signups')
    .select('*')
    .eq('player_id', playerId)
    .eq('week_id', week_id)
    .single()

  const updates = { updated_at: new Date().toISOString() }
  const now = new Date().toISOString()

  if (saturday && existing?.saturday_status !== 'confirmed' && existing?.saturday_status !== 'waitlist') {
    if (week.saturday_locked) return res.status(400).json({ error: 'Saturday signups are closed' })
    updates.saturday_status = satCount < week.saturday_max ? 'confirmed' : 'waitlist'
    updates.saturday_signed_up_at = now
  }

  if (sunday && existing?.sunday_status !== 'confirmed' && existing?.sunday_status !== 'waitlist') {
    if (week.sunday_locked) return res.status(400).json({ error: 'Sunday signups are closed' })
    updates.sunday_status = sunCount < week.sunday_max ? 'confirmed' : 'waitlist'
    updates.sunday_signed_up_at = now
  }

  let result
  if (existing) {
    const { data } = await supabase.from('signups').update(updates).eq('id', existing.id).select().single()
    result = data
  } else {
    const { data } = await supabase.from('signups').insert({
      player_id: playerId,
      week_id,
      ...updates
    }).select().single()
    result = data
  }

  res.json({
    signup: result,
    saturday_status: result.saturday_status,
    sunday_status: result.sunday_status
  })
})

// ─── POST /roster/cancel ─────────────────────────────────────
// Player cancels for a day — triggers waitlist promotion
router.post('/cancel', requireAuth, async (req, res) => {
  const { week_id, day } = req.body // day = 'saturday' | 'sunday'
  const playerId = req.player.id

  const { data: signup } = await supabase
    .from('signups')
    .select('*')
    .eq('player_id', playerId)
    .eq('week_id', week_id)
    .single()

  if (!signup) return res.status(404).json({ error: 'No signup found' })

  const statusField = day === 'saturday' ? 'saturday_status' : 'sunday_status'
  const wasConfirmed = signup[statusField] === 'confirmed'

  await supabase.from('signups').update({
    [statusField]: 'out',
    updated_at: new Date().toISOString()
  }).eq('id', signup.id)

  // If they were confirmed, promote the first waitlist player
  if (wasConfirmed) {
    await promoteFromWaitlist(week_id, day)
  }

  res.json({ message: `Cancelled for ${day}` })
})

// ─── POST /roster/claim ──────────────────────────────────────
// Waitlist player claims their spot
router.post('/claim', requireAuth, async (req, res) => {
  const { week_id, day } = req.body
  const playerId = req.player.id

  const { data: signup } = await supabase
    .from('signups')
    .select('*')
    .eq('player_id', playerId)
    .eq('week_id', week_id)
    .single()

  if (!signup) return res.status(404).json({ error: 'No signup found' })

  const statusField = day === 'saturday' ? 'saturday_status' : 'sunday_status'
  const expiresField = 'waitlist_claim_expires_at'

  if (signup[statusField] !== 'waitlist') {
    return res.status(400).json({ error: 'You are not on the waitlist for this day' })
  }

  if (signup[expiresField] && new Date(signup[expiresField]) < new Date()) {
    // Expired — move to next person
    await supabase.from('signups').update({ [statusField]: 'out' }).eq('id', signup.id)
    await promoteFromWaitlist(week_id, day)
    return res.status(400).json({ error: 'Your claim window expired. The spot went to the next player.' })
  }

  await supabase.from('signups').update({
    [statusField]: 'confirmed',
    waitlist_claim_expires_at: null,
    updated_at: new Date().toISOString()
  }).eq('id', signup.id)

  res.json({ message: `You're confirmed for ${day}!` })
})

// ─── Internal: promote first waitlist player ─────────────────
async function promoteFromWaitlist(weekId, day) {
  const statusField = day === 'saturday' ? 'saturday_status' : 'sunday_status'
  const signedUpField = day === 'saturday' ? 'saturday_signed_up_at' : 'sunday_signed_up_at'

  const { data: waitlist } = await supabase
    .from('signups')
    .select('*, player:players(*), week:weeks(*)')
    .eq('week_id', weekId)
    .eq(statusField, 'waitlist')
    .order(signedUpField, { ascending: true })
    .limit(1)

  if (!waitlist?.length) return

  const next = waitlist[0]
  const claimHours = parseInt(process.env.WAITLIST_CLAIM_HOURS || '2')
  const claimExpiresAt = new Date(Date.now() + claimHours * 60 * 60 * 1000).toISOString()

  await supabase.from('signups').update({
    waitlist_notified_at: new Date().toISOString(),
    waitlist_claim_expires_at: claimExpiresAt,
    updated_at: new Date().toISOString()
  }).eq('id', next.id)

  // Generate a fresh token for this notification
  const token = uuidv4()
  await supabase.from('magic_tokens').insert({
    player_id: next.player.id,
    token,
    expires_at: claimExpiresAt
  })

  await sendWaitlistOpening({
    player: next.player,
    token,
    week: next.week,
    day,
    claimExpiresAt
  })
}

export default router
