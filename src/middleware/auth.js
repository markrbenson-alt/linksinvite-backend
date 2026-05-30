import supabase from '../supabase.js'

export async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.cookies?.auth_token

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const { data: magicToken, error } = await supabase
    .from('magic_tokens')
    .select('*, player:players(*)')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error || !magicToken) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  req.player = magicToken.player
  req.token = token
  next()
}

export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.player.is_admin) {
      return res.status(403).json({ error: 'Admin access required' })
    }
    next()
  })
}
