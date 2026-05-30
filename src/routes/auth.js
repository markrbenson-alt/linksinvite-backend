import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import supabase from '../supabase.js'
import { sendMagicLink } from '../services/email.js'

const router = Router()

// POST /auth/magic-link
// Player enters their email, we send them a magic link
router.post('/magic-link', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })

  const { data: player, error } = await supabase
    .from('players')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .eq('is_active', true)
    .single()

  if (error || !player) {
    // Don't reveal whether email exists — always return success
    return res.json({ message: 'If that email is on our list, a sign-in link is on its way.' })
  }

  const token = uuidv4()
  await supabase.from('magic_tokens').insert({
    player_id: player.id,
    token,
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  })

  await sendMagicLink(player, token)
  res.json({ message: 'If that email is on our list, a sign-in link is on its way.' })
})

// GET /auth/verify?token=xxx
// Validates the token and returns player info + session token
router.get('/verify', async (req, res) => {
  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'Token required' })

  const { data: magicToken, error } = await supabase
    .from('magic_tokens')
    .select('*, player:players(*)')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error || !magicToken) {
    return res.status(401).json({ error: 'This link has expired or already been used.' })
  }

  // Don't consume the token — leave it valid for the session duration
  // (48h expiry on the token itself serves as the session)

  res.json({
    player: {
      id: magicToken.player.id,
      name: magicToken.player.name,
      email: magicToken.player.email,
      handicap_index: magicToken.player.handicap_index,
      is_admin: magicToken.player.is_admin
    },
    session_token: token
  })
})

export default router
