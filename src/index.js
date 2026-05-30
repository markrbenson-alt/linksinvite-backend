import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRoutes from './routes/auth.js'
import rosterRoutes from './routes/roster.js'
import adminRoutes from './routes/admin.js'
import { startAllJobs } from './jobs/scheduler.js'

const app = express()
const PORT = process.env.PORT || 3000

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://linksinvite.com',
    'https://www.linksinvite.com',
    /\.vercel\.app$/,         // Allow Vercel preview deploys
    'http://localhost:3001'   // Local frontend dev
  ],
  credentials: true
}))
app.use(express.json())

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Routes ───────────────────────────────────────────────────
app.use('/auth', authRoutes)
app.use('/roster', rosterRoutes)
app.use('/admin', adminRoutes)

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Internal server error' })
})

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LinksInvite backend running on port ${PORT}`)
  startAllJobs()
})

export default app
