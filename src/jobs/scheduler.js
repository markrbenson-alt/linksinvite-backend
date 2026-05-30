import cron from 'node-cron'
import supabase from '../supabase.js'
import { getWeekendWeather } from '../services/weather.js'
import {
  sendWeeklyInvite,
  sendReminder,
  sendFinalConfirmation,
  sendNonRespondentReport
} from '../services/email.js'
import { v4 as uuidv4 } from 'uuid'

// ─── Helpers ─────────────────────────────────────────────────

function getNextSaturday() {
  const d = new Date()
  const day = d.getDay()
  const daysUntilSat = (6 - day + 7) % 7 || 7
  d.setDate(d.getDate() + daysUntilSat)
  d.setHours(0, 0, 0, 0)
  return d
}

async function getOrCreateCurrentWeek() {
  const sat = getNextSaturday()
  const satStr = sat.toISOString().split('T')[0]

  let { data: week } = await supabase.from('weeks').select('*').eq('week_of', satStr).single()

  if (!week) {
    const weather = await getWeekendWeather(sat).catch(() => ({ saturday: {}, sunday: {} }))
    const { data } = await supabase.from('weeks').insert({
      week_of: satStr,
      saturday_rain_pct: weather.saturday.rainPct,
      saturday_low_temp: weather.saturday.lowTemp,
      saturday_high_temp: weather.saturday.highTemp,
      sunday_rain_pct: weather.sunday.rainPct,
      sunday_low_temp: weather.sunday.lowTemp,
      sunday_high_temp: weather.sunday.highTemp,
      weather_updated_at: new Date().toISOString()
    }).select().single()
    week = data
    console.log(`[CRON] Created week: ${satStr}`)
  }

  return week
}

async function generateTokenForPlayer(playerId, expiresHours = 168) {
  const token = uuidv4()
  await supabase.from('magic_tokens').insert({
    player_id: playerId,
    token,
    expires_at: new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString()
  })
  return token
}

async function getSignupStatus(weekId) {
  const { data: signups } = await supabase
    .from('signups')
    .select('*, player:players(id, name, email, handicap_index)')
    .eq('week_id', weekId)

  const satConfirmed = signups
    .filter(s => s.saturday_status === 'confirmed')
    .sort((a, b) => new Date(a.saturday_signed_up_at) - new Date(b.saturday_signed_up_at))
    .map(s => s.player)

  const sunConfirmed = signups
    .filter(s => s.sunday_status === 'confirmed')
    .sort((a, b) => new Date(a.sunday_signed_up_at) - new Date(b.sunday_signed_up_at))
    .map(s => s.player)

  return { signups, satConfirmed, sunConfirmed }
}

// ─── MONDAY 8:00 AM ET — Send weekly invite blast ────────────
// Cron: '0 8 * * 1' = 8am every Monday
// For Railway, set TZ=America/New_York

export function scheduleMonday() {
  cron.schedule('0 8 * * 1', async () => {
    console.log('[CRON] Monday blast starting...')
    try {
      const week = await getOrCreateCurrentWeek()

      // Refresh weather
      const sat = new Date(week.week_of + 'T12:00:00')
      const weather = await getWeekendWeather(sat)
      await supabase.from('weeks').update({
        saturday_rain_pct: weather.saturday.rainPct,
        saturday_low_temp: weather.saturday.lowTemp,
        saturday_high_temp: weather.saturday.highTemp,
        sunday_rain_pct: weather.sunday.rainPct,
        sunday_low_temp: weather.sunday.lowTemp,
        sunday_high_temp: weather.sunday.highTemp,
        weather_updated_at: new Date().toISOString()
      }).eq('id', week.id)

      const freshWeek = { ...week, ...weather.saturday, ...weather.sunday }

      // Get all active players
      const { data: players } = await supabase
        .from('players')
        .select('*')
        .eq('is_active', true)

      const { satConfirmed, sunConfirmed } = await getSignupStatus(week.id)

      // Send both Saturday and Sunday emails concurrently to each player
      let sentCount = 0
      for (const player of players) {
        const satToken = await generateTokenForPlayer(player.id)
        const sunToken = await generateTokenForPlayer(player.id)

        await Promise.all([
          sendWeeklyInvite({
            player, token: satToken, week, day: 'saturday',
            confirmedPlayers: satConfirmed,
            spotsRemaining: Math.max(0, week.saturday_max - satConfirmed.length)
          }),
          sendWeeklyInvite({
            player, token: sunToken, week, day: 'sunday',
            confirmedPlayers: sunConfirmed,
            spotsRemaining: Math.max(0, week.sunday_max - sunConfirmed.length)
          })
        ])
        sentCount++
      }

      await supabase.from('weeks').update({ invite_sent_at: new Date().toISOString() }).eq('id', week.id)
      console.log(`[CRON] Monday blast complete — ${sentCount} players notified`)

    } catch (err) {
      console.error('[CRON] Monday blast failed:', err)
    }
  }, { timezone: 'America/New_York' })
}

// ─── WEDNESDAY 8:00 AM ET — Reminder to non-respondents ──────
export function scheduleWednesday() {
  cron.schedule('0 8 * * 3', async () => {
    console.log('[CRON] Wednesday reminder starting...')
    try {
      const week = await getOrCreateCurrentWeek()

      // Refresh weather
      const sat = new Date(week.week_of + 'T12:00:00')
      const weather = await getWeekendWeather(sat)
      const updatedWeek = {
        ...week,
        saturday_rain_pct: weather.saturday.rainPct,
        saturday_low_temp: weather.saturday.lowTemp,
        saturday_high_temp: weather.saturday.highTemp,
        sunday_rain_pct: weather.sunday.rainPct,
        sunday_low_temp: weather.sunday.lowTemp,
        sunday_high_temp: weather.sunday.highTemp
      }
      await supabase.from('weeks').update({
        ...updatedWeek,
        weather_updated_at: new Date().toISOString()
      }).eq('id', week.id)

      const { data: allPlayers } = await supabase.from('players').select('*').eq('is_active', true)
      const { signups, satConfirmed, sunConfirmed } = await getSignupStatus(week.id)
      const signupMap = {}
      signups.forEach(s => { signupMap[s.player_id] = s })

      let reminderCount = 0
      for (const player of allPlayers) {
        const s = signupMap[player.id]
        const satResponded = s && s.saturday_status !== 'out'
        const sunResponded = s && s.sunday_status !== 'out'

        // Only remind players who haven't responded to either day
        if (!satResponded || !sunResponded) {
          const token = await generateTokenForPlayer(player.id)

          if (!satResponded && !week.saturday_locked) {
            await sendReminder({
              player, token, week: updatedWeek, day: 'saturday',
              confirmedPlayers: satConfirmed,
              spotsRemaining: Math.max(0, week.saturday_max - satConfirmed.length)
            })
          }

          if (!sunResponded && !week.sunday_locked) {
            const sunToken = await generateTokenForPlayer(player.id)
            await sendReminder({
              player, token: sunToken, week: updatedWeek, day: 'sunday',
              confirmedPlayers: sunConfirmed,
              spotsRemaining: Math.max(0, week.sunday_max - sunConfirmed.length)
            })
          }
          reminderCount++
        }
      }

      // Send non-respondent report to admin
      const satNoResponse = allPlayers.filter(p => !signupMap[p.id] || signupMap[p.id].saturday_status === 'out')
      const sunNoResponse = allPlayers.filter(p => !signupMap[p.id] || signupMap[p.id].sunday_status === 'out')

      await sendNonRespondentReport({
        adminEmail: process.env.ADMIN_EMAIL,
        week: updatedWeek,
        satNonResponders: satNoResponse,
        sunNonResponders: sunNoResponse
      })

      await supabase.from('weeks').update({ reminder_sent_at: new Date().toISOString() }).eq('id', week.id)
      console.log(`[CRON] Wednesday reminders sent to ${reminderCount} players`)

    } catch (err) {
      console.error('[CRON] Wednesday reminder failed:', err)
    }
  }, { timezone: 'America/New_York' })
}

// ─── FRIDAY 5:00 PM ET — Lock roster & send final confirmation
export function scheduleFriday() {
  cron.schedule('0 17 * * 5', async () => {
    console.log('[CRON] Friday lock & confirm starting...')
    try {
      const week = await getOrCreateCurrentWeek()

      // Final weather refresh
      const sat = new Date(week.week_of + 'T12:00:00')
      const weather = await getWeekendWeather(sat)
      const updatedWeek = {
        ...week,
        saturday_rain_pct: weather.saturday.rainPct,
        saturday_low_temp: weather.saturday.lowTemp,
        saturday_high_temp: weather.saturday.highTemp,
        sunday_rain_pct: weather.sunday.rainPct,
        sunday_low_temp: weather.sunday.lowTemp,
        sunday_high_temp: weather.sunday.highTemp
      }

      // Lock both days
      await supabase.from('weeks').update({
        saturday_locked: true,
        sunday_locked: true,
        ...updatedWeek,
        weather_updated_at: new Date().toISOString(),
        final_sent_at: new Date().toISOString()
      }).eq('id', week.id)

      const { signups, satConfirmed, sunConfirmed } = await getSignupStatus(week.id)

      // Send final confirmation to all confirmed Saturday players
      for (let i = 0; i < satConfirmed.length; i++) {
        const player = satConfirmed[i]
        await sendFinalConfirmation({
          player,
          week: updatedWeek,
          day: 'saturday',
          confirmedPlayers: satConfirmed,
          position: i + 1
        })
      }

      // Send final confirmation to all confirmed Sunday players
      for (let i = 0; i < sunConfirmed.length; i++) {
        const player = sunConfirmed[i]
        await sendFinalConfirmation({
          player,
          week: updatedWeek,
          day: 'sunday',
          confirmedPlayers: sunConfirmed,
          position: i + 1
        })
      }

      console.log(`[CRON] Friday lock complete — ${satConfirmed.length} Sat, ${sunConfirmed.length} Sun confirmed`)

    } catch (err) {
      console.error('[CRON] Friday lock failed:', err)
    }
  }, { timezone: 'America/New_York' })
}

// ─── Start all jobs ───────────────────────────────────────────
export function startAllJobs() {
  scheduleMonday()
  scheduleWednesday()
  scheduleFriday()
  console.log('[CRON] All scheduled jobs registered (Mon 8am, Wed 8am, Fri 5pm ET)')
}
