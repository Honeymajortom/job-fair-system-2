import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.jsx'

// v3.0 §10: LazyMotion(domAnimation) strict — m.* components only (~15KB of
// motion runtime). MotionConfig reducedMotion="user" is the global
// prefers-reduced-motion kill switch from the UI/UX spec.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
)
