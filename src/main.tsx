import '@fontsource-variable/public-sans'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { UsagePage } from './pages/UsagePage'
import './styles/app.css'
import './styles/pages.css'
import './styles/quota.css'
import './styles/usage.css'
import './styles/mobile.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="content">
      <UsagePage />
    </main>
  </StrictMode>,
)
