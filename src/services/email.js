import { Resend } from 'resend'
import 'dotenv/config'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = process.env.EMAIL_FROM || 'noreply@linksinvite.com'
const APP_URL = process.env.APP_URL || 'https://linksinvite.com'

// ─── Helpers ────────────────────────────────────────────────

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  })
}

function weatherLine(rainPct, low, high) {
  if (rainPct === null) return ''
  const rain = rainPct > 0 ? `A ${rainPct}% chance of rain is predicted. ` : 'No rain is expected. '
  return `${rain}Predicted low: ${low}°F | High: ${high}°F`
}

function rosterList(players) {
  if (!players.length) return 'No players signed up yet.'
  return players.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
}

// ─── Magic Link ──────────────────────────────────────────────

export async function sendMagicLink(player, token) {
  const link = `${APP_URL}/auth/verify?token=${token}`
  await resend.emails.send({
    from: FROM,
    to: player.email,
    subject: 'Your LinksInvite sign-in link',
    html: `
      <p>Hi ${player.name},</p>
      <p>Click the button below to sign in to LinksInvite. This link expires in 48 hours.</p>
      <p><a href="${link}" style="background:#2d6a2d;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Sign In</a></p>
      <p style="color:#666;font-size:12px;">Or copy this link: ${link}</p>
    `
  })
}

// ─── Monday Invite ───────────────────────────────────────────

export async function sendWeeklyInvite({ player, token, week, day, confirmedPlayers, spotsRemaining }) {
  const isSat = day === 'saturday'
  const dayLabel = isSat ? 'Saturday' : 'Sunday'
  const dateStr = isSat ? week.week_of : (() => {
    const d = new Date(week.week_of + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]
  })()
  const teeTime = isSat ? week.saturday_tee_time : week.sunday_tee_time
  const maxPlayers = isSat ? week.saturday_max : week.sunday_max
  const rainPct = isSat ? week.saturday_rain_pct : week.sunday_rain_pct
  const low = isSat ? week.saturday_low_temp : week.sunday_low_temp
  const high = isSat ? week.saturday_high_temp : week.sunday_high_temp
  const signupLink = `${APP_URL}/signup?token=${token}&week=${week.id}&day=${day}`

  const timeSlotsLabel = isSat ? '4 tee times' : '3 tee times'

  const subject = `⛳ ${dayLabel} Golf – ${formatDate(dateStr)} | ${spotsRemaining} spots open`

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;">
      <h2 style="color:#2d6a2d;border-bottom:2px solid #2d6a2d;padding-bottom:8px;">
        ${dayLabel}, ${formatDate(dateStr)}
      </h2>

      <p>We have <strong>${timeSlotsLabel}</strong> this ${dayLabel}, starting at <strong>${teeTime}</strong>.</p>

      ${rainPct !== null ? `<p style="background:#f5f5f5;padding:10px;border-radius:4px;">🌤️ ${weatherLine(rainPct, low, high)}</p>` : ''}

      <h3 style="color:#2d6a2d;">Playing so far:</h3>
      <ol style="line-height:1.8;">
        ${confirmedPlayers.length
          ? confirmedPlayers.map(p => `<li>${p.name}</li>`).join('')
          : '<li style="color:#999;">Be the first to sign up!</li>'
        }
      </ol>

      <p>We have <strong>${spotsRemaining} spot${spotsRemaining !== 1 ? 's' : ''} available</strong> as of now for ${dayLabel}, ${formatDate(dateStr)}.</p>

      <p style="margin:24px 0;">
        <a href="${signupLink}"
           style="background:#2d6a2d;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">
          Count Me In for ${dayLabel} ⛳
        </a>
      </p>

      <p style="color:#666;font-size:13px;">
        You can also view the full roster and manage your signup at
        <a href="${APP_URL}/roster/${week.id}">${APP_URL}/roster/${week.id}</a>
      </p>

      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;">
      <p style="color:#999;font-size:12px;">
        To unsubscribe from these emails, <a href="${APP_URL}/unsubscribe?email=${player.email}">click here</a>.
      </p>
    </div>
  `

  await resend.emails.send({ from: FROM, to: player.email, subject, html })
}

// ─── Wednesday Reminder (non-respondents only) ───────────────

export async function sendReminder({ player, token, week, day, confirmedPlayers, spotsRemaining }) {
  const isSat = day === 'saturday'
  const dayLabel = isSat ? 'Saturday' : 'Sunday'
  const dateStr = isSat ? week.week_of : (() => {
    const d = new Date(week.week_of + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]
  })()
  const teeTime = isSat ? week.saturday_tee_time : week.sunday_tee_time
  const rainPct = isSat ? week.saturday_rain_pct : week.sunday_rain_pct
  const low = isSat ? week.saturday_low_temp : week.sunday_low_temp
  const high = isSat ? week.saturday_high_temp : week.sunday_high_temp
  const signupLink = `${APP_URL}/signup?token=${token}&week=${week.id}&day=${day}`

  const subject = `⏰ Reminder: ${dayLabel} Golf – ${spotsRemaining} spots left | ${formatDate(dateStr)}`

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;">
      <h2 style="color:#2d6a2d;">Still time to join – ${dayLabel} Golf</h2>

      <p>Hi ${player.name}, you haven't signed up yet for <strong>${dayLabel}, ${formatDate(dateStr)}</strong>.</p>

      <p>First tee time: <strong>${teeTime}</strong> &nbsp;|&nbsp; <strong>${spotsRemaining} spots remaining</strong></p>

      ${rainPct !== null ? `<p style="background:#f5f5f5;padding:10px;border-radius:4px;">🌤️ ${weatherLine(rainPct, low, high)}</p>` : ''}

      <h3 style="color:#2d6a2d;">Currently signed up (${confirmedPlayers.length}):</h3>
      <ol style="line-height:1.8;">
        ${confirmedPlayers.map(p => `<li>${p.name}</li>`).join('')}
      </ol>

      <p style="margin:24px 0;">
        <a href="${signupLink}"
           style="background:#2d6a2d;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">
          I'm In for ${dayLabel} ⛳
        </a>
      </p>
    </div>
  `

  await resend.emails.send({ from: FROM, to: player.email, subject, html })
}

// ─── Friday Final Confirmation ───────────────────────────────

export async function sendFinalConfirmation({ player, week, day, confirmedPlayers, position }) {
  const isSat = day === 'saturday'
  const dayLabel = isSat ? 'Saturday' : 'Sunday'
  const dateStr = isSat ? week.week_of : (() => {
    const d = new Date(week.week_of + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]
  })()
  const teeTime = isSat ? week.saturday_tee_time : week.sunday_tee_time
  const rainPct = isSat ? week.saturday_rain_pct : week.sunday_rain_pct
  const low = isSat ? week.saturday_low_temp : week.sunday_low_temp
  const high = isSat ? week.saturday_high_temp : week.sunday_high_temp

  const subject = `✅ You're confirmed – ${dayLabel} Golf | ${formatDate(dateStr)}`

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;">
      <h2 style="color:#2d6a2d;">You're confirmed for ${dayLabel}!</h2>

      <p>Hi ${player.name}, you are <strong>#${position}</strong> on the confirmed list for
         <strong>${dayLabel}, ${formatDate(dateStr)}</strong>.</p>

      <p style="font-size:18px;">⏰ First tee time: <strong>${teeTime}</strong></p>

      ${rainPct !== null ? `<p style="background:#f5f5f5;padding:10px;border-radius:4px;">🌤️ ${weatherLine(rainPct, low, high)}</p>` : ''}

      <h3 style="color:#2d6a2d;">Final roster (${confirmedPlayers.length} players):</h3>
      <ol style="line-height:1.8;">
        ${confirmedPlayers.map(p => `<li>${p.name}${p.handicap_index ? ` <span style="color:#666;">(HCP ${p.handicap_index})</span>` : ''}</li>`).join('')}
      </ol>

      <p style="color:#666;font-size:13px;">
        Groups will be drawn randomly at the course. See you out there! 🏌️
      </p>
    </div>
  `

  await resend.emails.send({ from: FROM, to: player.email, subject, html })
}

// ─── Waitlist Notification ───────────────────────────────────

export async function sendWaitlistOpening({ player, token, week, day, claimExpiresAt }) {
  const isSat = day === 'saturday'
  const dayLabel = isSat ? 'Saturday' : 'Sunday'
  const claimLink = `${APP_URL}/claim?token=${token}&week=${week.id}&day=${day}`
  const expiresIn = process.env.WAITLIST_CLAIM_HOURS || 2

  const subject = `🔔 A ${dayLabel} spot just opened – claim it now!`

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;">
      <h2 style="color:#c47d00;">A spot just opened up!</h2>

      <p>Hi ${player.name}, a <strong>${dayLabel}</strong> spot has opened for this weekend's game.</p>

      <p>You have <strong>${expiresIn} hours</strong> to claim it before it goes to the next player on the waitlist.</p>

      <p style="margin:24px 0;">
        <a href="${claimLink}"
           style="background:#c47d00;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">
          Claim My Spot ⛳
        </a>
      </p>

      <p style="color:#666;font-size:13px;">This link expires at ${new Date(claimExpiresAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET.</p>
    </div>
  `

  await resend.emails.send({ from: FROM, to: player.email, subject, html })
}

// ─── Admin: Non-Respondent Report ───────────────────────────

export async function sendNonRespondentReport({ adminEmail, week, satNonResponders, sunNonResponders }) {
  const subject = `📋 LinksInvite – Non-Respondents as of ${new Date().toLocaleDateString()}`

  const list = (players) => players.length
    ? players.map(p => `<li>${p.name} &lt;${p.email}&gt;</li>`).join('')
    : '<li style="color:#999;">Everyone has responded!</li>'

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#222;">
      <h2 style="color:#2d6a2d;">Non-Respondent Report</h2>
      <p>Week of ${formatDate(week.week_of)}</p>

      <h3>Saturday (${satNonResponders.length} haven't responded):</h3>
      <ol>${list(satNonResponders)}</ol>

      <h3>Sunday (${sunNonResponders.length} haven't responded):</h3>
      <ol>${list(sunNonResponders)}</ol>

      <p style="color:#666;font-size:13px;">
        View full roster: <a href="${process.env.APP_URL}/admin/roster/${week.id}">${process.env.APP_URL}/admin/roster/${week.id}</a>
      </p>
    </div>
  `

  await resend.emails.send({ from: FROM, to: adminEmail, subject, html })
}
